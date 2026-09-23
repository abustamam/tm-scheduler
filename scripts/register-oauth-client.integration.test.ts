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
	const SUPER_EMAIL = `register-super-${SUFFIX}@example.com`;
	const PLAIN_EMAIL = `register-plain-${SUFFIX}@example.com`;
	const userIds: string[] = [];
	const names: string[] = [];
	let nameCount = 0;
	let deps: RegisterDeps;

	/** A name no other test uses, so each case builds its own state. */
	const freshName = () => {
		const name = `registration probe ${SUFFIX} ${nameCount++}`;
		names.push(name);
		return name;
	};

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
		deps = {
			db: testDb as never,
			handler: auth.handler,
			context: await auth.$context,
		};
	});

	afterAll(async () => {
		if (names.length > 0) {
			await testDb.delete(oauthClient).where(inArray(oauthClient.name, names));
		}
		await testDb.delete(session).where(inArray(session.userId, userIds));
		await testDb.delete(user).where(inArray(user.id, userIds));
	});

	const register = (name: string, overrides: Partial<RegisterArgs> = {}) =>
		registerOAuthClient(deps, {
			mode: "register",
			as: SUPER_EMAIL,
			name,
			redirectUri: "https://client.example/callback",
			force: false,
			...overrides,
		});

	const clientsNamed = (name: string) =>
		testDb.select().from(oauthClient).where(eq(oauthClient.name, name));

	const sessionsOf = async (id: string) =>
		(await testDb.select().from(session).where(eq(session.userId, id))).length;

	it("refuses a user who is not a superadmin, naming why, and mints no session", async () => {
		const name = freshName();
		const outcome = await register(name, { as: PLAIN_EMAIL });
		expect(outcome).toMatchObject({
			kind: "refused",
			reason: expect.stringMatching(/not a superadmin/),
		});
		expect(await clientsNamed(name)).toEqual([]);
		expect(await sessionsOf(userIds[1] as string)).toBe(0);
	});

	it("creates a confidential client bound to /api/mcp, and prints the secret once", async () => {
		const name = freshName();
		const outcome = await register(name);
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
			name,
			force: false,
		}).lines.join("\n");
		expect(printed.split(outcome.clientSecret).length - 1).toBe(1);
		expect(printed).toContain("cannot be recovered");
		expect(printed).toContain("node .output/register-oauth-client.mjs");
	});

	it("refuses a rerun with the same name, naming the client, its creator and how to rotate", async () => {
		const name = freshName();
		expect((await register(name)).kind).toBe("created");
		const outcome = await register(name);
		expect(outcome.kind).toBe("exists");
		const { lines, exitCode } = describeOutcome(outcome, {
			mode: "register",
			as: PLAIN_EMAIL,
			name,
			force: false,
		});
		expect(exitCode).toBe(1);
		// The hint names the CREATOR, not whoever ran the script: the provider
		// lets only the creator rotate.
		expect(lines.join("\n")).toContain(`--as ${SUPER_EMAIL} --rotate-secret`);
		expect(await clientsNamed(name)).toHaveLength(1);
	});

	it("--force makes a second one", async () => {
		const name = freshName();
		expect((await register(name)).kind).toBe("created");
		expect((await register(name, { force: true })).kind).toBe("created");
		expect(await clientsNamed(name)).toHaveLength(2);
	});

	it("rotates a secret", async () => {
		const created = await register(freshName());
		if (created.kind !== "created") throw new Error("no client to rotate");
		const [before] = await testDb
			.select({ secret: oauthClient.clientSecret })
			.from(oauthClient)
			.where(eq(oauthClient.clientId, created.clientId));
		const outcome = await registerOAuthClient(deps, {
			mode: "rotate",
			as: SUPER_EMAIL,
			clientId: created.clientId,
			force: false,
		});
		expect(outcome.kind).toBe("rotated");
		const [after] = await testDb
			.select({ secret: oauthClient.clientSecret })
			.from(oauthClient)
			.where(eq(oauthClient.clientId, created.clientId));
		expect(after?.secret).not.toBe(before?.secret);
	});

	it("never renews its five-minute session, and deletes it", async () => {
		// Without the signed `dont_remember` cookie, Better Auth's session
		// middleware extends a five-minute row to seven days on first use.
		const expiries: number[] = [];
		const watching: RegisterDeps = {
			...deps,
			handler: async (request) => {
				const res = await deps.handler(request);
				const rows = await testDb
					.select({ expiresAt: session.expiresAt })
					.from(session)
					.where(eq(session.userId, userIds[0] as string));
				for (const r of rows) expiries.push(r.expiresAt.getTime());
				return res;
			},
		};
		const outcome = await registerOAuthClient(watching, {
			mode: "register",
			as: SUPER_EMAIL,
			name: freshName(),
			redirectUri: "https://client.example/callback",
			force: false,
		});
		expect(outcome.kind).toBe("created");
		expect(expiries.length).toBeGreaterThan(0);
		for (const at of expiries) {
			expect(at - Date.now()).toBeLessThan(10 * 60 * 1000);
		}
		expect(await sessionsOf(userIds[0] as string)).toBe(0);
		const [owner] = await testDb
			.select({ isSuperadmin: user.isSuperadmin })
			.from(user)
			.where(eq(user.email, SUPER_EMAIL));
		expect(owner?.isSuperadmin).toBe(true);
	});

	it("keeps the secret when the session cannot be deleted, and says so", async () => {
		// A failed delete in `finally` used to replace the outcome, losing the
		// only copy of a secret the registration had already committed.
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const failingDelete = new Proxy(testDb, {
			get: (target, prop, receiver) =>
				prop === "delete"
					? () => {
							throw new Error("delete failed");
						}
					: Reflect.get(target, prop, receiver),
		});
		const name = freshName();
		const outcome = await registerOAuthClient(
			{ ...deps, db: failingDelete as never },
			{
				mode: "register",
				as: SUPER_EMAIL,
				name,
				redirectUri: "https://client.example/callback",
				force: false,
			},
		);
		expect(outcome.kind).toBe("created");
		if (outcome.kind !== "created") return;
		expect(outcome.clientSecret.length).toBeGreaterThan(0);
		expect(outcome.sessionLeft).toBeTruthy();
		const printed = describeOutcome(outcome, {
			mode: "register",
			as: SUPER_EMAIL,
			name,
			force: false,
		}).lines.join("\n");
		expect(printed).toContain(outcome.clientSecret);
		expect(printed).toContain(`could not be deleted`);
		log.mockRestore();
		await testDb.delete(session).where(eq(session.id, outcome.sessionLeft as string));
	});
});
