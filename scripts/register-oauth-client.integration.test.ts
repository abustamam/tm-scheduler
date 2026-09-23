/**
 * `register-oauth-client.ts` (#843) against the real `auth.handler` and the
 * test database: it registers once, refuses a rerun, rotates, and leaves no
 * session behind.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run scripts/register-oauth-client.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { oauthClient, session, user } from "#/db/auth-schema";
import { hasTestDb, testDb } from "#/test/db";
import {
	describeOutcome,
	parseRegisterArgs,
	type RegisterArgs,
	type RegisterDeps,
	registerOAuthClient,
} from "./register-oauth-client-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe("parseRegisterArgs", () => {
	it("reads a registration", () => {
		expect(
			parseRegisterArgs([
				"--as",
				"a@example.com",
				"--name",
				"claude.ai",
				"--redirect-uri",
				"https://claude.ai/api/mcp/auth_callback",
			]),
		).toEqual({
			mode: "register",
			as: "a@example.com",
			name: "claude.ai",
			redirectUri: "https://claude.ai/api/mcp/auth_callback",
			force: false,
		});
	});

	it("reads a rotation", () => {
		expect(
			parseRegisterArgs(["--as", "a@example.com", "--rotate-secret", "cid"]),
		).toEqual({ mode: "rotate", as: "a@example.com", clientId: "cid", force: false });
	});

	it("refuses what it cannot act on", () => {
		for (const argv of [
			[],
			["--name", "x", "--redirect-uri", "https://x.example/cb"],
			["--as", "a@example.com", "--redirect-uri", "https://x.example/cb"],
			["--as", "a@example.com", "--name", "x"],
			["--as", "a@example.com", "--name", "x", "--redirect-uri", "not a url"],
			// A plain-http redirect URI would carry the code in the clear.
			["--as", "a@example.com", "--name", "x", "--redirect-uri", "http://x.example/cb"],
			["--as", "a@example.com", "--rotate-secret"],
			["--as", "--name", "x"],
		]) {
			expect(parseRegisterArgs(argv), argv.join(" ")).toHaveProperty("error");
		}
	});
});

describe.skipIf(!hasTestDb)("registerOAuthClient (#843)", () => {
	const SUFFIX = randomBytes(4).toString("hex");
	const NAME = `registration probe ${SUFFIX}`;
	const SUPER_EMAIL = `register-super-${SUFFIX}@example.com`;
	const PLAIN_EMAIL = `register-plain-${SUFFIX}@example.com`;
	const userIds: string[] = [];
	let deps: RegisterDeps;

	beforeAll(async () => {
		for (const [email, isSuperadmin] of [
			[SUPER_EMAIL, true],
			[PLAIN_EMAIL, false],
		] as const) {
			const id = randomUUID();
			userIds.push(id);
			await testDb.insert(user).values({
				id,
				name: email,
				email,
				emailVerified: true,
				isSuperadmin,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		}
		const { auth } = await import("#/lib/auth");
		deps = { db: testDb as never, handler: auth.handler, context: await auth.$context };
	});

	afterAll(async () => {
		await testDb.delete(oauthClient).where(eq(oauthClient.name, NAME));
		await testDb.delete(user).where(inArray(user.id, userIds));
	});

	const register = (overrides: Partial<RegisterArgs> = {}) =>
		registerOAuthClient(deps, {
			mode: "register",
			as: SUPER_EMAIL,
			name: NAME,
			redirectUri: "https://client.example/callback",
			force: false,
			...overrides,
		});

	const sessionsFor = async (id: string) =>
		(await testDb.select().from(session).where(eq(session.userId, id))).length;

	it("refuses a user who is not a superadmin, and writes no client", async () => {
		const outcome = await register({ as: PLAIN_EMAIL });
		expect(outcome.kind).toBe("refused");
		expect(
			await testDb.select().from(oauthClient).where(eq(oauthClient.name, NAME)),
		).toEqual([]);
	});

	it("creates a confidential client bound to /api/mcp, and prints the secret once", async () => {
		const outcome = await register();
		expect(outcome.kind).toBe("created");
		if (outcome.kind !== "created") return;
		const [row] = await testDb
			.select()
			.from(oauthClient)
			.where(eq(oauthClient.clientId, outcome.clientId));
		expect(row?.tokenEndpointAuthMethod).toBe("client_secret_post");
		expect(row?.grantTypes).toEqual(["authorization_code", "refresh_token"]);
		expect(row?.redirectUris).toEqual(["https://client.example/callback"]);
		// Stored hashed, as the printed warning says — never the value shown.
		expect(row?.clientSecret).not.toBe(outcome.clientSecret);
		// Bound to the MCP resource by `mcp()`'s registration defaults, which is
		// what makes its tokens JWTs with `/api/mcp` as their audience.
		const resources = await testDb.execute<{ resource_id: string }>(
			sql`select resource_id from oauth_client_resource where client_id = ${outcome.clientId}`,
		);
		expect(resources.rows.map((r) => r.resource_id)).toEqual([
			"http://localhost:3000/api/mcp",
		]);

		const printed = describeOutcome(outcome, {
			mode: "register",
			as: SUPER_EMAIL,
			name: NAME,
			force: false,
		}).lines.join("\n");
		expect(printed.split(outcome.clientSecret).length - 1).toBe(1);
		expect(printed).toContain("cannot be recovered");
	});

	it("refuses a rerun with the same name, naming the client and how to rotate", async () => {
		const outcome = await register();
		expect(outcome.kind).toBe("exists");
		const { lines, exitCode } = describeOutcome(outcome, {
			mode: "register",
			as: SUPER_EMAIL,
			name: NAME,
			force: false,
		});
		expect(exitCode).toBe(1);
		expect(lines.join("\n")).toContain("--rotate-secret");
		expect(
			(await testDb.select().from(oauthClient).where(eq(oauthClient.name, NAME)))
				.length,
		).toBe(1);
	});

	it("--force makes a second one", async () => {
		expect((await register({ force: true })).kind).toBe("created");
		expect(
			(await testDb.select().from(oauthClient).where(eq(oauthClient.name, NAME)))
				.length,
		).toBe(2);
	});

	it("rotates a secret", async () => {
		const [row] = await testDb
			.select({ clientId: oauthClient.clientId, secret: oauthClient.clientSecret })
			.from(oauthClient)
			.where(eq(oauthClient.name, NAME))
			.limit(1);
		const outcome = await registerOAuthClient(deps, {
			mode: "rotate",
			as: SUPER_EMAIL,
			clientId: row?.clientId,
			force: false,
		});
		expect(outcome.kind).toBe("rotated");
		const [after] = await testDb
			.select({ secret: oauthClient.clientSecret })
			.from(oauthClient)
			.where(eq(oauthClient.clientId, row?.clientId as string));
		expect(after?.secret).not.toBe(row?.secret);
	});

	it("leaves no session behind, and never flips the superadmin flag", async () => {
		// The minted session is deleted in `finally`, and it is inserted
		// directly rather than through the sign-in hook that would reconcile
		// SUPERADMIN_EMAILS — which, unset here, would revoke the flag.
		expect(await sessionsFor(userIds[0] as string)).toBe(0);
		const [owner] = await testDb
			.select({ isSuperadmin: user.isSuperadmin })
			.from(user)
			.where(eq(user.email, SUPER_EMAIL));
		expect(owner?.isSuperadmin).toBe(true);
	});
});
