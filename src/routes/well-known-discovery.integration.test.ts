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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
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

describe.skipIf(!hasTestDb)("OAuth discovery at the origin root (#842)", () => {
	let handler: (request: Request) => Promise<Response>;

	beforeAll(async () => {
		// Before the import, not after: `#/db` throws at module load on an unset
		// `DATABASE_URL`, and `setup-env.ts` deliberately does not fill it in —
		// a test must never be one missing export away from the dev database.
		process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
		// `BETTER_AUTH_URL` is filled by `setup-env.ts`, and it is what makes the
		// MCP resource a legal loopback HTTP URL rather than a rejected one.
		expect(process.env.BETTER_AUTH_URL).toBe(ORIGIN);
		const { auth } = await import("#/lib/auth");
		handler = auth.handler;
	});

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
