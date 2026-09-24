/**
 * The two OAuth discovery documents, and the registration endpoint that must
 * stay shut (#842 / ADR-0027).
 *
 * ## Why this drives the REAL `auth`
 *
 * These assertions are about what GavelUp actually serves. A suite that built
 * its own `betterAuth({ plugins: [jwt(), mcp({…})] })` would restate the
 * configuration under test, so it would keep passing after someone changed
 * `src/lib/auth.ts` — including after someone turned Dynamic Client
 * Registration ON, which is the single configuration mistake here that opens a
 * public write endpoint on gavelup.app.
 *
 * So it imports `#/lib/auth`, which imports `#/db`, which throws unless
 * `DATABASE_URL` is set. The suite is DB-gated anyway (Better Auth's schema
 * check and the `oauth_client` row count both need a database), so it points
 * `DATABASE_URL` at `TEST_DATABASE_URL` before that import and skips entirely
 * when there is none — the same shape as every other integration suite here.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/routes/well-known-discovery.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AUTH_BASE_PATH,
	MCP_RESOURCE_PATH,
	serveWellKnownDiscovery,
} from "#/lib/well-known-forward";
import { hasTestDb, testDb } from "#/test/db";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost:3000";
const AUTH_SERVER = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

/** The issuer every discovery document must name: Better Auth's base URL. */
const ISSUER = `${ORIGIN}${AUTH_BASE_PATH}`;

/** Per-run, so rows this file writes cannot collide with a parallel suite's. */
const SUFFIX = randomBytes(4).toString("hex");
const PROBE_CLIENT_NAME = `unauthorized probe ${SUFFIX}`;
const ALLOWED_CLIENT_NAME = `superadmin probe ${SUFFIX}`;
const SUPERADMIN_PROBE_EMAIL = `oauth-admin-${SUFFIX}@example.com`;
/** Every user this file signs in, so `afterAll` deletes its own rows and no others. */
const seededEmails = new Set<string>();
/**
 * This file mutates two process-global env vars, and vitest reuses a worker
 * across test FILES — so leaving them set leaks a sign-in bypass and a
 * superadmin allowlist into whatever runs next in the same process.
 * `superadmin.integration.test.ts`, `impersonation.integration.test.ts`,
 * `dev-login.test.ts` and `public-readers-archive-gate.guard.test.ts` all read
 * one of them. Saved here and restored in `afterAll`, the way
 * `superadmin.integration.test.ts` already does with its own `prevEnv`.
 */
const PREV_ENV = {
	SUPERADMIN_EMAILS: process.env.SUPERADMIN_EMAILS,
	ENABLE_DEV_LOGIN: process.env.ENABLE_DEV_LOGIN,
};

describe.skipIf(!hasTestDb)("OAuth discovery at the origin root (#842)", () => {
	let handler: (request: Request) => Promise<Response>;
	let takeDevMagicLink: (email: string) => string | undefined;

	beforeAll(async () => {
		// Assigned, NOT `??=`. With `??=`, a `DATABASE_URL` already in the
		// environment stays put, and then the handler under test writes to THAT
		// database while `countOauthClients()` reads `TEST_DATABASE_URL` — so the
		// row-count assertions below compare a database nothing touched and
		// cannot fail, while the probes land in the developer's dev data.
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// `BETTER_AUTH_URL` is filled by `setup-env.ts`, and it is what makes the
		// MCP resource a legal loopback HTTP URL rather than a rejected one.
		expect(process.env.BETTER_AUTH_URL).toBe(ORIGIN);
		// Lets `signedInMember` complete a real sign-in with no inbox: `auth.ts`'s
		// `sendMagicLink` stashes the verify URL when this is on. It is a sign-in
		// bypass, so it is set here rather than in `setup-env.ts`, and
		// `dev-login.test.ts` guards that it can never be on in production.
		process.env.ENABLE_DEV_LOGIN = "1";
		// Set BEFORE the import so `session.create.after`'s reconcile grants the
		// flag on this run's superadmin probe, and on nobody else.
		process.env.SUPERADMIN_EMAILS = SUPERADMIN_PROBE_EMAIL;
		const { auth } = await import("#/lib/auth");
		handler = auth.handler;
		({ takeDevMagicLink } = await import("#/lib/dev-login"));
	});

	afterAll(async () => {
		// Scoped to this run's own names and emails. `cleanup()` cascades from a
		// club and every row here is club-less, so nothing else would ever remove
		// them — and vitest runs test FILES in parallel against one `tm_test`, so
		// an unscoped delete would take a neighbouring suite's in-flight rows.
		await testDb.execute(
			sql`delete from oauth_client where name in (${PROBE_CLIENT_NAME}, ${ALLOWED_CLIENT_NAME})`,
		);
		// Signing in mints a `user`, a `session` and a `verification`. The first
		// draft cleaned up only the client row — which the test two lines above
		// asserts was never created — and left eight users behind per run.
		//
		// A magic-link `verification` row keys on the TOKEN; the email lives in
		// the JSON `value`. Matching `identifier` alone deleted nothing, and an
		// unconsumed link has no user to cascade from, so every run left one row
		// per magic-link request behind. The column is `text`, so `value` is
		// matched on its quoted JSON spelling.
		for (const email of seededEmails) {
			await testDb.execute(
				sql`delete from verification where identifier like ${`%${email}%`} or value like ${`%"${email}"%`}`,
			);
			await testDb.execute(sql`delete from "user" where email = ${email}`);
		}
		for (const [key, value] of Object.entries(PREV_ENV)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	/**
	 * A real session cookie for a brand-new, non-superadmin user.
	 *
	 * Goes through Better Auth's own magic-link verify endpoint rather than
	 * minting or signing a cookie by hand, so what the assertions exercise is
	 * the same session middleware a browser would hit. The email is per-run and
	 * previously unseen, so the user it creates is exactly the case under
	 * test: an ordinary member with no elevated flag.
	 */
	async function signedInMember(
		kind: "member" | "superadmin" = "member",
	): Promise<{ cookie: string }> {
		const email =
			kind === "superadmin"
				? SUPERADMIN_PROBE_EMAIL
				: `oauth-probe-${SUFFIX}@example.com`;
		seededEmails.add(email);
		const { auth } = await import("#/lib/auth");
		await auth.api.signInMagicLink({
			body: { email, callbackURL: "/" },
			headers: new Headers(),
		});
		const verifyUrl = takeDevMagicLink(email);
		if (!verifyUrl) throw new Error(`no magic link captured for ${email}`);
		const verified = await handler(new Request(verifyUrl));
		const setCookie = verified.headers.get("set-cookie");
		if (!setCookie) throw new Error("verify returned no Set-Cookie");
		const cookie = setCookie
			.split(",")
			.map((part) => part.trim().split(";")[0])
			.filter((pair) => pair.includes("="))
			.join("; ");
		return { cookie };
	}

	const get = (pathname: string) =>
		serveWellKnownDiscovery(new Request(`${ORIGIN}${pathname}`), handler);

	it("serves RFC 9728 protected-resource metadata naming /api/mcp and this issuer", async () => {
		const response = await get(PROTECTED_RESOURCE);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.resource).toBe(`${ORIGIN}${MCP_RESOURCE_PATH}`);
		expect(body.authorization_servers).toContain(ISSUER);
	});

	it("serves RFC 8414 authorization-server metadata with the endpoints a client needs", async () => {
		const response = await get(AUTH_SERVER);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.issuer).toBe(ISSUER);
		expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
		expect(body.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
	});

	it("advertises Client ID Metadata Documents and public clients — what makes claude.ai choose CIMD (#852)", async () => {
		// claude.ai picks CIMD only when BOTH are present; with either missing it
		// falls back to Dynamic Client Registration, which is off here, and the
		// connection fails. The confidential methods stay, for the hand-registered
		// client. That `registration_endpoint` is still absent is the case below.
		const body = await (await get(AUTH_SERVER)).json();
		expect(body.client_id_metadata_document_supported).toBe(true);
		expect(body.token_endpoint_auth_methods_supported).toContain("none");
		expect(body.token_endpoint_auth_methods_supported).toContain(
			"client_secret_post",
		);
	});

	it("answers the issuer-path-inserted alias with a byte-identical document", async () => {
		// Not "also 200": a client that discovers through the alias and a client
		// that discovers through the bare path must be configuring themselves
		// against the same server.
		const bare = await (await get(AUTH_SERVER)).text();
		const alias = await (await get(`${AUTH_SERVER}${AUTH_BASE_PATH}`)).text();
		expect(alias).toBe(bare);
	});

	it("advertises no registration_endpoint in either document", async () => {
		// DCR off means the endpoint is absent from discovery entirely, so a
		// client never tries it. Asserted as an absent KEY rather than by
		// grepping the body, so a `registration_endpoint: null` would fail too.
		for (const pathname of [AUTH_SERVER, PROTECTED_RESOURCE]) {
			const body = await (await get(pathname)).json();
			expect(Object.keys(body)).not.toContain("registration_endpoint");
		}
	});

	it("refuses client registration AND writes no oauth_client row", async () => {
		// The row count is the assertion that matters. A non-2xx status can be
		// returned by a handler that has already written — and a registration
		// endpoint that records the client and then rejects the response would
		// look identical from outside.
		const before = await countOauthClients();
		const response = await handler(
			new Request(`${ORIGIN}${AUTH_BASE_PATH}/oauth2/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
					client_name: "unauthorized probe",
				}),
			}),
		);
		expect(response.ok).toBe(false);
		expect(await countOauthClients()).toBe(before);
	});

	it("refuses client creation for a member who is not a superadmin", async () => {
		// `/oauth2/register` is not the only registration path, and DCR being off
		// does not close this one: `/oauth2/create-client` is separately routed,
		// carries only `sessionMiddleware`, and `assertClientPrivileges` is inert
		// unless `clientPrivileges` is passed. Before that callback existed, a
		// plain member got 201 with a client_id, a client_secret and their own
		// redirect_uris — verified against a live server.
		//
		// Driven through `auth.handler` with a real session cookie rather than
		// `auth.api.*`, because the session middleware is half of what is under
		// test. The Origin header is required: without it the request dies at the
		// CSRF origin check, which would make this pass for the wrong reason.
		const { cookie } = await signedInMember();
		const before = await countOauthClients();
		const response = await handler(
			new Request(`${ORIGIN}${AUTH_BASE_PATH}/oauth2/create-client`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: ORIGIN,
					cookie,
				},
				body: JSON.stringify({
					redirect_uris: ["https://attacker.example/cb"],
					client_name: PROBE_CLIENT_NAME,
				}),
			}),
		);
		expect(response.status).toBe(401);
		// The row count is the assertion that matters: a handler can reject the
		// response after it has already written.
		expect(await countOauthClients()).toBe(before);
	});

	it("still allows a superadmin to register one — the gate is not just 'deny'", async () => {
		// This is the assertion that makes the one above mean something. A
		// `clientPrivileges` callback that denies EVERYONE passes the refusal test
		// perfectly, and that is exactly what shipped in the first draft of this
		// fix: it read `user.isSuperadmin` off the session, which Better Auth's
		// adapter never populates, so the maintainer's own registration script
		// would have got a 401 too. Without this case, nothing tells the two
		// apart.
		const { cookie } = await signedInMember("superadmin");
		const before = await countOauthClients();
		const response = await handler(
			new Request(`${ORIGIN}${AUTH_BASE_PATH}/oauth2/create-client`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: ORIGIN,
					cookie,
				},
				body: JSON.stringify({
					redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
					client_name: ALLOWED_CLIENT_NAME,
				}),
			}),
		);
		expect(response.status).toBe(201);
		expect(await countOauthClients()).toBe(before + 1);
	});

	it("exempts the discovery documents from the auth rate limiter", async () => {
		// The global rule is 20 requests per 60s and the limiter runs BEFORE the
		// plugin hooks, so without the exemption the 21st discovery request in a
		// minute is a 429 — and when the client IP cannot be resolved (any
		// multi-hop x-forwarded-for) every caller shares ONE bucket, which behind
		// a proxy makes that limit global. 40 is comfortably past the ceiling.
		for (let i = 0; i < 40; i++) {
			const response = await get(PROTECTED_RESOURCE);
			expect(
				response.status,
				`request ${i + 1} was metered — the customRules exemption is not matching`,
			).toBe(200);
		}
	});

	it("still meters the magic-link path — the exemption is not a blanket one", async () => {
		// The mutation this closes: exempting by wildcard, or keying the rule off
		// something broad enough to take the sign-in limit with it.
		let sawRefusal = false;
		seededEmails.add(`ratelimit-${SUFFIX}@example.com`);
		for (let i = 0; i < 12; i++) {
			const response = await handler(
				new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/magic-link`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: ORIGIN },
					body: JSON.stringify({
						email: `ratelimit-${SUFFIX}@example.com`,
						callbackURL: "/",
					}),
				}),
			);
			if (response.status === 429) sawRefusal = true;
		}
		expect(sawRefusal).toBe(true);
	});

	describe("rate-limit buckets are per client, keyed on X-Real-IP (#847)", () => {
		/**
		 * A per-run client address in TEST-NET-3, so no two runs — and no other
		 * test in this file — share a bucket. The limiter's store is an
		 * in-process Map that lives as long as the worker, and every request
		 * with no `x-real-ip` falls back to `127.0.0.1` under test, which is the
		 * bucket the "still meters the magic-link path" test above drains.
		 */
		const base = randomBytes(1)[0] ?? 0;
		let issued = 0;
		/** Distinct on every call within a run: a counter from a random start. */
		const clientIp = () => `203.0.113.${1 + ((base + issued++) % 254)}`;
		let emailCount = 0;

		/** One magic-link request as a Railway-fronted client would send it. */
		function magicLink(headers: Record<string, string>) {
			const email = `ip-bucket-${SUFFIX}-${emailCount++}@example.com`;
			seededEmails.add(email);
			return handler(
				new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/magic-link`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: ORIGIN,
						...headers,
					},
					body: JSON.stringify({ email, callbackURL: "/" }),
				}),
			);
		}

		/** Spend the whole 5/60s allowance for `ip`, asserting none of it was refused. */
		async function exhaust(ip: string, extra: () => Record<string, string>) {
			for (let i = 0; i < 5; i++) {
				const response = await magicLink({ "x-real-ip": ip, ...extra() });
				expect(response.status, `request ${i + 1} from ${ip}`).not.toBe(429);
			}
		}

		it("reads x-real-ip and nothing else", async () => {
			// Pinned as configuration because the spoofing test below cannot catch
			// `x-forwarded-for` added AFTER `x-real-ip`: the first header that
			// resolves wins, so a request carrying both never reaches the second.
			// It still matters — a request arriving without `x-real-ip` would then
			// be keyed on a value the client chose.
			const { auth } = await import("#/lib/auth");
			expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
				"x-real-ip",
			]);
		});

		it("refuses the 6th magic-link request from one client, and not a different client's first", async () => {
			const first = clientIp();
			const second = clientIp();

			await exhaust(first, () => ({}));
			expect((await magicLink({ "x-real-ip": first })).status).toBe(429);
			// The bug this issue is about: one shared bucket meant a second client
			// was refused here too.
			expect((await magicLink({ "x-real-ip": second })).status).not.toBe(429);
		});

		it("does not let a client choose its bucket with x-forwarded-for", async () => {
			// Rotating a single-entry x-forwarded-for is what the default config
			// trusted. With it no longer consulted, all six share one bucket.
			const ip = clientIp();
			let n = 0;
			const spoof = () => ({ "x-forwarded-for": `198.51.100.${++n}` });
			await exhaust(ip, spoof);
			expect((await magicLink({ "x-real-ip": ip, ...spoof() })).status).toBe(
				429,
			);
		});

		it("records the client address on the session it creates", async () => {
			// `session.ip_address` is written from the same resolution the limiter
			// uses, and in production it held the empty string on every row. The
			// session is created by the VERIFY request, so that is the one that
			// carries the header.
			const ip = clientIp();
			const email = `ip-session-${SUFFIX}@example.com`;
			seededEmails.add(email);
			const { auth } = await import("#/lib/auth");
			await auth.api.signInMagicLink({
				body: { email, callbackURL: "/" },
				headers: new Headers(),
			});
			const verifyUrl = takeDevMagicLink(email);
			if (!verifyUrl) throw new Error(`no magic link captured for ${email}`);
			await handler(new Request(verifyUrl, { headers: { "x-real-ip": ip } }));
			const rows = await testDb.execute<{ ip_address: string | null }>(
				sql`select s.ip_address from session s join "user" u on u.id = s.user_id where u.email = ${email}`,
			);
			expect(rows.rows.map((row) => row.ip_address)).toEqual([ip]);
		});
	});

	it("does not hand arbitrary origin-root paths to the auth handler", async () => {
		// The splat catches every `.well-known` path. This is the assertion that
		// it stays two documents wide against the REAL handler, not just against
		// the stub the unit suite uses.
		for (const pathname of [
			"/.well-known/openid-configuration",
			"/.well-known/jwks.json",
			"/.well-known/anything-else",
		]) {
			expect((await get(pathname)).status).toBe(404);
		}
	});
});

/**
 * The route really calls the forwarder, with the real auth handler.
 *
 * A `createFileRoute` handler body cannot be reached from a test (#544), so
 * everything above drives `serveWellKnownDiscovery` directly. That leaves
 * exactly one gap — a route wired to something else, or to nothing — and this
 * closes it by reading the source. Comment-blind, via `readSource`: this is a
 * "must be present" guard, and a file that merely mentioned the call in a
 * comment would otherwise satisfy it.
 */
describe("the /.well-known/$ route is wired to the forwarder", () => {
	const source = readSource(join(HERE, "[.]well-known.$.ts"));

	it("registers the splat path the discovery URLs live under", () => {
		// The `[.]` bracket escape is what makes the file resolve to
		// `/.well-known/$` instead of a `/well-known` segment. Renaming the file
		// without it would leave both documents 404 with every other test green.
		expect(source).toContain('createFileRoute("/.well-known/$")');
	});

	it("delegates both methods to serveWellKnownDiscovery with auth.handler", () => {
		expect(source).toContain(
			'import { serveWellKnownDiscovery } from "#/lib/well-known-forward"',
		);
		for (const method of ["GET", "POST"]) {
			expect(source).toMatch(
				new RegExp(
					`${method}:\\s*\\(\\{ request \\}\\) =>\\s*serveWellKnownDiscovery\\(request, auth\\.handler\\)`,
				),
			);
		}
	});
});

async function countOauthClients(): Promise<number> {
	const rows = await testDb.execute<{ count: string }>(
		sql`select count(*)::text as count from oauth_client`,
	);
	return Number(rows.rows[0]?.count ?? "-1");
}
