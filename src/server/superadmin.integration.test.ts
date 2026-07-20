/**
 * DB-backed tests for the platform superadmin role (ADR-0016 / #183): the
 * two-way reconcile of `user.is_superadmin` from the SUPERADMIN_EMAILS allowlist
 * (grant on add, revoke on remove), fail-closed when the allowlist is empty, and
 * the `requireSuperadmin` guard. `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/superadmin.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { user } from "#/db/schema";
import { reconcileSuperadminFlag } from "#/lib/superadmin";
import { requireSuperadmin } from "#/server/guards";
import { hasTestDb, testDb } from "#/test/db";

// Static, not per-test `await import()`: `vi.mock` is hoisted above these, so
// they still resolve `#/db` to the test database, and the allowlist is read at
// CALL time (see `parseSuperadminEmails`) so nothing here captures env at load.
// Importing lazily charged the first test to touch a module with its cold load —
// which is how `#/server/guards`, used only by the last test, blew a 5s budget
// under full-suite contention (#290).
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const ENV_KEY = "SUPERADMIN_EMAILS";

describe.skipIf(!hasTestDb)("superadmin platform role (#183)", () => {
	const createdUserIds: string[] = [];
	const prevEnv = process.env[ENV_KEY];

	async function seedUser(
		email: string,
		isSuperadmin = false,
	): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "SA Test",
			email,
			emailVerified: true,
			isSuperadmin,
		});
		createdUserIds.push(id);
		return id;
	}

	async function flagOf(id: string): Promise<boolean> {
		const [row] = await testDb
			.select({ isSuperadmin: user.isSuperadmin })
			.from(user)
			.where(eq(user.id, id))
			.limit(1);
		return row?.isSuperadmin ?? false;
	}

	afterEach(async () => {
		if (createdUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, createdUserIds));
			createdUserIds.length = 0;
		}
		if (prevEnv === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prevEnv;
	});

	it("grants when the email is in the allowlist (persists the flag)", async () => {
		const email = `grant-${randomUUID()}@test.example`;
		const id = await seedUser(email, false);
		process.env[ENV_KEY] = `someone@else.test, ${email}`;
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(true);
		expect(await flagOf(id)).toBe(true);
	});

	it("revokes on the next reconcile when the email leaves the allowlist (two-way)", async () => {
		const email = `revoke-${randomUUID()}@test.example`;
		const id = await seedUser(email, true); // currently a superadmin
		process.env[ENV_KEY] = "only-someone-else@test.example";
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(false);
		expect(await flagOf(id)).toBe(false);
	});

	it("matches case-insensitively and ignores surrounding whitespace", async () => {
		const email = `case-${randomUUID()}@test.example`;
		const id = await seedUser(email, false);
		process.env[ENV_KEY] = `  ${email.toUpperCase()}  `;
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(true);
	});

	it("fails closed: an unset allowlist grants nobody (and revokes existing)", async () => {
		const email = `closed-${randomUUID()}@test.example`;
		const id = await seedUser(email, true);
		delete process.env[ENV_KEY];
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(false);
		expect(await flagOf(id)).toBe(false);
	});

	it("fails closed: an all-whitespace allowlist grants nobody", async () => {
		const email = `empty-${randomUUID()}@test.example`;
		const id = await seedUser(email, false);
		process.env[ENV_KEY] = "   ,  ";
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(false);
	});

	it("is idempotent — repeated reconciles keep the same flag", async () => {
		const email = `idem-${randomUUID()}@test.example`;
		const id = await seedUser(email, false);
		process.env[ENV_KEY] = email;
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(true);
		expect(await reconcileSuperadminFlag(id, testDb)).toBe(true);
		expect(await flagOf(id)).toBe(true);
	});

	it("reconcile returns false for an unknown user id", async () => {
		process.env[ENV_KEY] = "anyone@test.example";
		expect(await reconcileSuperadminFlag(randomUUID(), testDb)).toBe(false);
	});

	it("requireSuperadmin passes for a superadmin and throws for others", async () => {
		const superId = await seedUser(`super-${randomUUID()}@test.example`, true);
		const normalId = await seedUser(
			`normal-${randomUUID()}@test.example`,
			false,
		);
		await expect(requireSuperadmin(superId)).resolves.toBeUndefined();
		await expect(requireSuperadmin(normalId)).rejects.toThrow(/permission/i);
		// An unknown user id is likewise rejected (fail closed).
		await expect(requireSuperadmin(randomUUID())).rejects.toThrow();
	});
});
