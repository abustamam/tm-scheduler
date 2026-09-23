/**
 * Register (or rotate) the OAuth client claude.ai connects with (#843 /
 * ADR-0027). The CLI is `register-oauth-client.ts`; this is the part a test
 * can drive.
 *
 * Dynamic Client Registration is off, so this is the ONE way a client row is
 * made, and it goes through Better Auth's own `/oauth2/create-client` rather
 * than an INSERT: the provider decides how the secret is stored, which
 * resources the client is bound to (`/api/mcp`, via `mcp()`'s defaults) and
 * what the row looks like, and a hand-written row would be this repo's guess
 * at all three.
 *
 * ## Why it mints its own short-lived session
 *
 * Both endpoints are session-gated, and `clientPrivileges` (`src/lib/auth.ts`)
 * admits only a superadmin. A script has no browser, so it acts as a named
 * superadmin by inserting a `session` row directly, signing its token the way
 * Better Auth signs a cookie, and deleting the row when it is done.
 *
 * It does NOT go through `internalAdapter.createSession`, and that is
 * deliberate: that path runs the `session.create.after` hook, which reconciles
 * `SUPERADMIN_EMAILS` two-way. Run locally with production's `DATABASE_URL`
 * and no `SUPERADMIN_EMAILS` exported, it would REVOKE the maintainer's own
 * superadmin flag — and then refuse to register the client for want of it.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { db as appDb } from "#/db";
import { oauthClient, session, user } from "#/db/auth-schema";

export interface RegisterArgs {
	mode: "register" | "rotate";
	/** Superadmin to act as. */
	as: string;
	name?: string;
	redirectUri?: string;
	force: boolean;
	/** For `rotate`. */
	clientId?: string;
}

export const USAGE = `Usage:
  bun run scripts/register-oauth-client.ts --as <superadmin email> \\
    --name <client name> --redirect-uri <uri> [--force]
  bun run scripts/register-oauth-client.ts --as <superadmin email> \\
    --rotate-secret <client_id>

Runs against DATABASE_URL, with BETTER_AUTH_URL and BETTER_AUTH_SECRET as the
deployed server has them — the secret signs the session, and a different one
makes every request here a 401.`;

/** Parse argv, or return the reason it cannot be. */
export function parseRegisterArgs(
	argv: readonly string[],
): RegisterArgs | { error: string } {
	const value = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		if (i === -1) return undefined;
		const v = argv[i + 1];
		return v && !v.startsWith("--") ? v : "";
	};
	const as = value("--as");
	if (!as) return { error: "--as <superadmin email> is required." };
	const rotate = value("--rotate-secret");
	if (rotate !== undefined) {
		if (!rotate) return { error: "--rotate-secret needs a client_id." };
		return { mode: "rotate", as, clientId: rotate, force: false };
	}
	const name = value("--name");
	const redirectUri = value("--redirect-uri");
	if (!name) return { error: "--name is required." };
	if (!redirectUri) return { error: "--redirect-uri is required." };
	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		return { error: `--redirect-uri is not a URL: ${redirectUri}` };
	}
	if (parsed.protocol !== "https:") {
		return { error: "--redirect-uri must be https." };
	}
	return {
		mode: "register",
		as,
		name,
		redirectUri,
		force: argv.includes("--force"),
	};
}

type Db = typeof appDb;
type Handler = (request: Request) => Promise<Response>;

export interface RegisterDeps {
	db: Db;
	handler: Handler;
	/** `(await auth.$context)` — the secret, base URL and cookie name. */
	context: {
		secret: string;
		baseURL: string;
		authCookies: { sessionToken: { name: string } };
	};
}

export type RegisterOutcome =
	| { kind: "created"; clientId: string; clientSecret: string }
	| { kind: "rotated"; clientId: string; clientSecret: string }
	| { kind: "exists"; clientIds: string[] }
	| { kind: "refused"; reason: string };

/** Better Auth's signed-cookie encoding (`better-call`'s `signCookieValue`). */
function signCookieValue(value: string, secret: string): string {
	const signature = createHmac("sha256", secret).update(value).digest("base64");
	return encodeURIComponent(`${value}.${signature}`);
}

/**
 * Act as `email` for one request's worth of work, then remove the session.
 * Refuses unless that user is a superadmin in the database — the same read
 * `clientPrivileges` does, checked first so the failure names the cause.
 */
async function withSuperadminSession<T>(
	deps: RegisterDeps,
	email: string,
	run: (cookie: string) => Promise<T>,
): Promise<T | { kind: "refused"; reason: string }> {
	const [owner] = await deps.db
		.select({ id: user.id, isSuperadmin: user.isSuperadmin })
		.from(user)
		.where(eq(user.email, email.toLowerCase()))
		.limit(1);
	if (!owner) return { kind: "refused", reason: `No user with email ${email}.` };
	if (!owner.isSuperadmin) {
		return {
			kind: "refused",
			reason: `${email} is not a superadmin, and only a superadmin may register OAuth clients (clientPrivileges in src/lib/auth.ts).`,
		};
	}
	const token = randomBytes(24).toString("base64url");
	const id = randomUUID();
	await deps.db.insert(session).values({
		id,
		token,
		userId: owner.id,
		// Long enough for two requests, short enough that a crash mid-run leaves
		// nothing useful behind.
		expiresAt: new Date(Date.now() + 5 * 60 * 1000),
		createdAt: new Date(),
		updatedAt: new Date(),
		userAgent: "scripts/register-oauth-client.ts",
	});
	try {
		const cookie = `${deps.context.authCookies.sessionToken.name}=${signCookieValue(token, deps.context.secret)}`;
		return await run(cookie);
	} finally {
		await deps.db.delete(session).where(eq(session.id, id));
	}
}

/** POST to one of Better Auth's own endpoints, as the minted session. */
async function post(
	deps: RegisterDeps,
	cookie: string,
	path: string,
	body: unknown,
): Promise<Response> {
	const url = `${deps.context.baseURL}${path}`;
	return deps.handler(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(url).origin,
				cookie,
			},
			body: JSON.stringify(body),
		}),
	);
}

export async function registerOAuthClient(
	deps: RegisterDeps,
	args: RegisterArgs,
): Promise<RegisterOutcome> {
	if (args.mode === "rotate") {
		const clientId = args.clientId as string;
		return withSuperadminSession(deps, args.as, async (cookie) => {
			const res = await post(deps, cookie, "/oauth2/client/rotate-secret", {
				client_id: clientId,
			});
			if (!res.ok) {
				return {
					kind: "refused" as const,
					reason: `rotate-secret answered ${res.status}: ${await res.text()}`,
				};
			}
			const body = (await res.json()) as { client_secret?: string };
			if (!body.client_secret) {
				return {
					kind: "refused" as const,
					reason: "rotate-secret returned no client_secret.",
				};
			}
			return {
				kind: "rotated" as const,
				clientId,
				clientSecret: body.client_secret,
			};
		});
	}

	const name = args.name as string;
	// Refuse a second client with the same name unless asked. A rerun that
	// silently mints a duplicate leaves a live credential nobody knows to
	// revoke.
	const existing = await deps.db
		.select({ clientId: oauthClient.clientId })
		.from(oauthClient)
		.where(eq(oauthClient.name, name));
	if (existing.length > 0 && !args.force) {
		return { kind: "exists", clientIds: existing.map((c) => c.clientId) };
	}

	return withSuperadminSession(deps, args.as, async (cookie) => {
		const res = await post(deps, cookie, "/oauth2/create-client", {
			client_name: name,
			redirect_uris: [args.redirectUri],
			token_endpoint_auth_method: "client_secret_post",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		});
		if (res.status !== 201 && res.status !== 200) {
			return {
				kind: "refused" as const,
				reason: `create-client answered ${res.status}: ${await res.text()}`,
			};
		}
		const body = (await res.json()) as {
			client_id?: string;
			client_secret?: string;
		};
		if (!body.client_id || !body.client_secret) {
			return {
				kind: "refused" as const,
				reason: "create-client returned no client_id or client_secret.",
			};
		}
		return {
			kind: "created" as const,
			clientId: body.client_id,
			clientSecret: body.client_secret,
		};
	});
}

/** The lines the CLI prints for an outcome. The secret appears exactly once. */
export function describeOutcome(
	outcome: RegisterOutcome,
	args: RegisterArgs,
): { lines: string[]; exitCode: number } {
	const rotateHint = (clientId: string) =>
		`  bun run scripts/register-oauth-client.ts --as ${args.as} --rotate-secret ${clientId}`;
	switch (outcome.kind) {
		case "created":
		case "rotated":
			return {
				exitCode: 0,
				lines: [
					outcome.kind === "created"
						? `Registered OAuth client "${args.name}".`
						: "Rotated the client secret. The old one stops working now.",
					"",
					`  Client ID:     ${outcome.clientId}`,
					`  Client secret: ${outcome.clientSecret}`,
					"",
					"The secret is shown ONCE and cannot be recovered: it is not stored in",
					"plain text anywhere. Paste both into claude.ai's connector Advanced",
					"settings now. Do not put them in a file, an env template, the repo,",
					"or a PR. If it is lost, rotate it:",
					rotateHint(outcome.clientId),
				],
			};
		case "exists":
			return {
				exitCode: 1,
				lines: [
					`A client named "${args.name}" already exists: ${outcome.clientIds.join(", ")}`,
					"Nothing was created. To get a new secret for it, rotate it:",
					...outcome.clientIds.map(rotateHint),
					"To create a SECOND client with the same name anyway, pass --force.",
				],
			};
		case "refused":
			return { exitCode: 1, lines: [`Refused: ${outcome.reason}`] };
	}
}
