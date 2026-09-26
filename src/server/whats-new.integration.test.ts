/**
 * DB-backed tests for the "What's new" seen state (#947): the header dot's
 * `user.whats_new_seen_at` and the badges' `user_feature_seen`.
 *
 * Club-less rows (users only), so this suite cleans up after itself by the ids
 * it created, with per-run emails — never an unscoped delete.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/whats-new.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { user, userFeatureSeen } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadWhatsNewState, markFeatureSeenLogic, markWhatsNewSeenLogic } =
	await import("./whats-new-logic");

describe.skipIf(!hasTestDb)("whats-new seen state", () => {
	const userIds: string[] = [];

	async function makeUser(): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Reader",
			email: `whats-new-${id}@example.test`,
			emailVerified: true,
		});
		userIds.push(id);
		return id;
	}

	afterEach(async () => {
		if (userIds.length === 0) return;
		// `user_feature_seen` cascades from `user`.
		await testDb.delete(user).where(inArray(user.id, userIds));
		userIds.length = 0;
	});

	it("a new user has never opened the panel and has seen no feature", async () => {
		const id = await makeUser();
		expect(await loadWhatsNewState(id)).toEqual({
			seenAt: null,
			featuresSeen: [],
		});
	});

	it("opening the panel stamps whats_new_seen_at for that user only", async () => {
		const a = await makeUser();
		const b = await makeUser();
		const at = new Date("2026-09-26T12:00:00.000Z");
		expect(await markWhatsNewSeenLogic(a, at)).toBe(at.toISOString());
		expect((await loadWhatsNewState(a)).seenAt).toBe(at.toISOString());
		expect((await loadWhatsNewState(b)).seenAt).toBeNull();
	});

	it("a feature seen is recorded once, per user, and kept", async () => {
		const a = await makeUser();
		const b = await makeUser();
		await markFeatureSeenLogic(a, "promote");
		// Idempotent: the unique index turns a second use into a no-op.
		await markFeatureSeenLogic(a, "promote");
		await markFeatureSeenLogic(a, "account");
		expect((await loadWhatsNewState(a)).featuresSeen.sort()).toEqual([
			"account",
			"promote",
		]);
		expect((await loadWhatsNewState(b)).featuresSeen).toEqual([]);
		const rows = await testDb
			.select()
			.from(userFeatureSeen)
			.where(eq(userFeatureSeen.userId, a));
		expect(rows.length).toBe(2);
	});

	it("deleting the account deletes its badge state", async () => {
		const a = await makeUser();
		await markFeatureSeenLogic(a, "promote");
		await testDb.delete(user).where(eq(user.id, a));
		const rows = await testDb
			.select()
			.from(userFeatureSeen)
			.where(eq(userFeatureSeen.userId, a));
		expect(rows).toEqual([]);
	});
});
