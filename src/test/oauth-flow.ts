/**
 * Drive a REAL OAuth 2.1 authorization-code grant through GavelUp's own
 * `auth.handler`, for the suites that need an access token (#843).
 *
 * Nothing here signs a JWT or writes an `oauth_*` row by hand. A token minted
 * that way would pass whatever the test author believed the provider does,
 * and the point of the #843 suites is to catch the provider doing something
 * else — a different issuer, an opaque token where a JWT was expected, an
 * audience that is the issuer rather than `/api/mcp`. So every step is the
 * HTTP request a browser or claude.ai would send:
 *
 *   1. a real magic-link sign-in (session cookie),
 *   2. `/oauth2/create-client` as a superadmin (the registration script's path),
 *   3. `/oauth2/authorize` with PKCE — which answers with the consent redirect,
 *   4. `/oauth2/consent` with the signed query that redirect carried,
 *   5. `/oauth2/token`, `client_secret_post`, exactly as claude.ai redeems it.
 *
 * It needs `#/lib/auth` loaded against the test database, which the caller
 * arranges (see `loadAuthForTest`); and it mutates `ENABLE_DEV_LOGIN` and
 * `SUPERADMIN_EMAILS`, which `restoreEnv` puts back.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { AUTH_BASE_PATH, MCP_RESOURCE_PATH } from "#/lib/well-known-forward";
import { testDb } from "#/test/db";

/** `setup-env.ts` fills `BETTER_AUTH_URL` with this; the issuer derives from it. */
export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_ISSUER = `${TEST_ORIGIN}${AUTH_BASE_PATH}`;
export const TEST_RESOURCE = `${TEST_ORIGIN}${MCP_RESOURCE_PATH}`;
export const TEST_REDIRECT_URI = "https://client.example/callback";

type Handler = (request: Request) => Promise<Response>;

/**
 * A fresh client address for one request, in RFC 2544's benchmarking block.
 *
 * Better Auth meters `/api/auth/*` at 20 requests a minute per client address
 * (`src/lib/auth.ts`), keyed on `x-real-ip`, and a request with none falls
 * into one shared bucket. One grant is four requests, so a suite that mints a
 * handful of tokens exhausts that bucket — and the failure it produces, a
 * verify with no cookie or an authorize with no redirect, reads like a broken
 * flow rather than a metered one. Every request here gets its own address.
 */
function clientIp(): string {
	const [a, b] = randomBytes(2);
	return `198.18.${a ?? 0}.${1 + ((b ?? 0) % 254)}`;
}

interface LoadedAuth {
	handler: Handler;
	auth: typeof import("#/lib/auth").auth;
	takeDevMagicLink: (email: string) => string | undefined;
}

const PREV_ENV_KEYS = ["ENABLE_DEV_LOGIN", "SUPERADMIN_EMAILS"] as const;

/**
 * Import `#/lib/auth` with sign-in-without-an-inbox switched on and
 * `superadminEmail` on the allowlist. Returns a restore function: vitest
 * reuses a worker across files, so leaving either variable set leaks a
 * sign-in bypass into whatever runs next.
 */
export async function loadAuthForTest(
	superadminEmail: string,
): Promise<LoadedAuth & { restoreEnv: () => void }> {
	const prev = Object.fromEntries(
		PREV_ENV_KEYS.map((k) => [k, process.env[k]]),
	);
	process.env.ENABLE_DEV_LOGIN = "1";
	process.env.SUPERADMIN_EMAILS = superadminEmail;
	const { auth } = await import("#/lib/auth");
	const { takeDevMagicLink } = await import("#/lib/dev-login");
	return {
		auth,
		handler: auth.handler,
		takeDevMagicLink,
		restoreEnv: () => {
			for (const [key, value] of Object.entries(prev)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

/**
 * Serve `${TEST_ISSUER}/jwks` from `auth.handler` in-process.
 *
 * `/api/mcp`'s verifier fetches the key set over HTTP from `BETTER_AUTH_URL`
 * (see `oauth-credential.ts`), and there is no server listening under vitest.
 * This routes exactly that one URL to the same handler a deployed server would
 * answer it with — the real key set, from the real `jwks` table — and passes
 * every other request through untouched. Returns the restore function.
 */
export function routeJwksToHandler(handler: Handler): () => void {
	const realFetch = globalThis.fetch;
	const jwksUrl = `${TEST_ISSUER}/jwks`;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url === jwksUrl) {
			const headers = new Headers(init?.headers);
			headers.set("x-real-ip", clientIp());
			return handler(new Request(url, { ...init, headers }));
		}
		return realFetch(input, init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = realFetch;
	};
}

/**
 * Send `email` a magic link with `callbackURL`, then open it — in a browser
 * with no cookies, which is also what a second device is. Returns the verify
 * response: its `Location` is where the link lands, its `Set-Cookie` the new
 * session.
 */
export async function openMagicLink(
	loaded: LoadedAuth,
	email: string,
	callbackURL = "/",
): Promise<Response> {
	await loaded.auth.api.signInMagicLink({
		body: { email, callbackURL },
		headers: new Headers(),
	});
	const verifyUrl = loaded.takeDevMagicLink(email);
	if (!verifyUrl) throw new Error(`no magic link captured for ${email}`);
	return loaded.handler(
		new Request(verifyUrl, { headers: { "x-real-ip": clientIp() } }),
	);
}

/** A real session cookie for `email`, via Better Auth's own magic-link verify. */
export async function signInCookie(
	loaded: LoadedAuth,
	email: string,
): Promise<string> {
	return cookieHeaderFrom(await openMagicLink(loaded, email));
}

/** `GET` a same-origin path with a session, as the browser following a redirect. */
export function follow(
	loaded: LoadedAuth,
	path: string,
	cookie: string,
): Promise<Response> {
	return loaded.handler(
		new Request(new URL(path, TEST_ORIGIN), {
			headers: { accept: "text/html", cookie, "x-real-ip": clientIp() },
		}),
	);
}

/** Collapse a response's `Set-Cookie` into a request `Cookie` header. */
export function cookieHeaderFrom(response: Response): string {
	const setCookies = response.headers.getSetCookie();
	if (setCookies.length === 0) throw new Error("response set no cookie");
	return setCookies.map((c) => c.split(";")[0]).join("; ");
}

export interface RegisteredClient {
	clientId: string;
	clientSecret: string;
}

/** Register a confidential client as a superadmin — the registration script's path. */
export async function registerClient(
	loaded: LoadedAuth,
	superadminCookie: string,
	name: string,
): Promise<RegisteredClient> {
	const response = await loaded.handler(
		new Request(`${TEST_ISSUER}/oauth2/create-client`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: TEST_ORIGIN,
				cookie: superadminCookie,
				"x-real-ip": clientIp(),
			},
			body: JSON.stringify({
				client_name: name,
				redirect_uris: [TEST_REDIRECT_URI],
				token_endpoint_auth_method: "client_secret_post",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			}),
		}),
	);
	if (response.status !== 201 && response.status !== 200) {
		throw new Error(
			`create-client ${response.status}: ${await response.text()}`,
		);
	}
	const body = (await response.json()) as {
		client_id: string;
		client_secret: string;
	};
	return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** Where `/oauth2/authorize` sent the browser, and the query it signed. */
export interface AuthorizeRedirect {
	location: URL;
	verifier: string;
}

/** `GET /oauth2/authorize` with PKCE, as claude.ai starts the flow. */
export async function startAuthorize(
	loaded: LoadedAuth,
	client: RegisteredClient,
	cookie: string | null,
): Promise<AuthorizeRedirect> {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const url = new URL(`${TEST_ISSUER}/oauth2/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: client.clientId,
		redirect_uri: TEST_REDIRECT_URI,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: randomBytes(8).toString("hex"),
		resource: TEST_RESOURCE,
	}).toString();
	const response = await loaded.handler(
		new Request(url, {
			headers: {
				accept: "text/html",
				"x-real-ip": clientIp(),
				...(cookie ? { cookie } : {}),
			},
		}),
	);
	const location = response.headers.get("location");
	if (!location) {
		throw new Error(
			`authorize answered ${response.status} with no redirect: ${await response.text()}`,
		);
	}
	return { location: new URL(location, TEST_ORIGIN), verifier };
}

/** `POST /oauth2/consent`, exactly as `/oauth/consent` sends it. */
export async function postConsent(
	loaded: LoadedAuth,
	cookie: string,
	oauthQuery: string,
	accept: boolean,
): Promise<Response> {
	return loaded.handler(
		new Request(`${TEST_ISSUER}/oauth2/consent`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: TEST_ORIGIN,
				cookie,
				"x-real-ip": clientIp(),
			},
			body: JSON.stringify({ accept, oauth_query: oauthQuery }),
		}),
	);
}

/** Redeem an authorization code at `/oauth2/token`, `client_secret_post`. */
export async function redeemCode(
	loaded: LoadedAuth,
	client: RegisteredClient,
	code: string,
	verifier: string,
): Promise<{ access_token: string; token_type: string }> {
	const response = await loaded.handler(
		new Request(`${TEST_ISSUER}/oauth2/token`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-real-ip": clientIp(),
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: TEST_REDIRECT_URI,
				client_id: client.clientId,
				client_secret: client.clientSecret,
				resource: TEST_RESOURCE,
			}).toString(),
		}),
	);
	if (!response.ok) {
		throw new Error(`token ${response.status}: ${await response.text()}`);
	}
	return (await response.json()) as {
		access_token: string;
		token_type: string;
	};
}

/**
 * The whole grant for a signed-in user: authorize → consent → token.
 * Returns the access token claude.ai would present to `/api/mcp`.
 */
export async function mintAccessToken(
	loaded: LoadedAuth,
	client: RegisteredClient,
	userCookie: string,
): Promise<string> {
	const { location, verifier } = await startAuthorize(
		loaded,
		client,
		userCookie,
	);
	let codeUrl = location;
	// A user who has already consented to this client goes straight to the
	// redirect URI; one who has not lands on the consent page first.
	if (!location.href.startsWith(TEST_REDIRECT_URI)) {
		const consent = await postConsent(
			loaded,
			userCookie,
			location.search.slice(1),
			true,
		);
		const body = (await consent.json()) as {
			url?: string;
			redirect_uri?: string;
		};
		const next = body.url ?? body.redirect_uri;
		if (!next)
			throw new Error(`consent gave no redirect: ${JSON.stringify(body)}`);
		codeUrl = new URL(next);
	}
	const code = codeUrl.searchParams.get("code");
	if (!code) throw new Error(`no code in ${codeUrl.href}`);
	const tokens = await redeemCode(loaded, client, code, verifier);
	return tokens.access_token;
}

/**
 * Delete what a suite's OAuth flow created: its clients (which cascade to
 * tokens and consents) and its users' magic-link verification rows. Scoped to
 * this run's own ids — every row here is club-less, so `cleanup()` never
 * reaches it, and an unscoped delete takes a parallel suite's in-flight rows.
 */
export async function cleanupOAuth(
	clientIds: readonly string[],
	emails: readonly string[],
): Promise<void> {
	for (const clientId of clientIds) {
		await testDb.execute(
			sql`delete from oauth_access_token where client_id = ${clientId}`,
		);
		await testDb.execute(
			sql`delete from oauth_refresh_token where client_id = ${clientId}`,
		);
		await testDb.execute(
			sql`delete from oauth_consent where client_id = ${clientId}`,
		);
		await testDb.execute(
			sql`delete from oauth_client where client_id = ${clientId}`,
		);
	}
	for (const email of emails) {
		await testDb.execute(
			sql`delete from verification where identifier like ${`%${email}%`} or value like ${`%"${email}"%`}`,
		);
		await testDb.execute(sql`delete from "user" where email = ${email}`);
	}
}
