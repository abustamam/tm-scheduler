/**
 * DB-backed tests for sync-token logic (#107). Tests the plain fns directly;
 * `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/sync-tokens-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTokens } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("sync-token logic", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await testDb.delete(syncTokens).where(eq(syncTokens.clubId, seed.clubId));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("hashToken is deterministic and generateRawToken is prefixed + unique", async () => {
		const { generateRawToken, hashToken } = await import(
			"#/server/sync-tokens-logic"
		);
		const a = generateRawToken();
		const b = generateRawToken();
		expect(a).toMatch(/^gup_[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
		expect(hashToken(a)).toBe(hashToken(a));
		expect(hashToken(a)).not.toBe(hashToken(b));
	});

	it("createSyncToken returns the raw token once and stores only its hash", async () => {
		const { createSyncToken, hashToken } = await import(
			"#/server/sync-tokens-logic"
		);
		const created = await createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: "VPE laptop",
		});
		expect(created.token).toMatch(/^gup_/);

		const [row] = await testDb
			.select()
			.from(syncTokens)
			.where(eq(syncTokens.id, created.id));
		expect(row.tokenHash).toBe(hashToken(created.token));
		expect(row.name).toBe("VPE laptop");
		expect(JSON.stringify(row)).not.toContain(created.token);
	});

	it("resolveActiveToken returns the club for a live token and null for a revoked/unknown one", async () => {
		const { createSyncToken, resolveActiveToken, revokeSyncToken } =
			await import("#/server/sync-tokens-logic");
		const created = await createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: null,
		});
		const ok = await resolveActiveToken(created.token);
		expect(ok?.clubId).toBe(seed.clubId);
		expect(ok?.basecampClubGuid).toBeNull();

		expect(await resolveActiveToken("gup_does-not-exist")).toBeNull();

		await revokeSyncToken({ clubId: seed.clubId, tokenId: created.id });
		expect(await resolveActiveToken(created.token)).toBeNull();
	});

	it("listSyncTokens never exposes the hash or raw token", async () => {
		const { createSyncToken, listSyncTokens } = await import(
			"#/server/sync-tokens-logic"
		);
		const created = await createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: "one",
		});
		const list = await listSyncTokens(seed.clubId);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(created.id);
		expect(list[0]).not.toHaveProperty("tokenHash");
		expect(JSON.stringify(list)).not.toContain(created.token);
	});
});
