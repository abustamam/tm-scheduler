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
import { WHATS_NEW_ENTRIES } from "#/lib/whats-new";
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

	it("a new user has seen no entry and no feature", async () => {
		const id = await makeUser();
		expect(await loadWhatsNewState(id)).toEqual({
			seenIds: [],
			featuresSeen: [],
		});
	});

	it("opening the panel unions the shown ids, for that user only", async () => {
		const [known1, known2] = WHATS_NEW_ENTRIES.map((e) => e.id);
		expect(known2).toBeDefined();
		const a = await makeUser();
		const b = await makeUser();
		expect(await markWhatsNewSeenLogic(a, [known1])).toEqual([known1]);
		// A second open adds, never replaces, and repeats collapse.
		const after = await markWhatsNewSeenLogic(a, [known2, known1]);
		expect([...after].sort()).toEqual([known1, known2].sort());
		expect((await loadWhatsNewState(a)).seenIds.sort()).toEqual(
			[known1, known2].sort(),
		);
		expect((await loadWhatsNewState(b)).seenIds).toEqual([]);
	});

	it("ids that are not shipped entries are dropped", async () => {
		const a = await makeUser();
		expect(await markWhatsNewSeenLogic(a, ["not-an-entry"])).toEqual([]);
	});

	it("reading the panel does not bump the account's updated_at", async () => {
		const a = await makeUser();
		const [before] = await testDb
			.select({ updatedAt: user.updatedAt })
			.from(user)
			.where(eq(user.id, a));
		await new Promise((r) => setTimeout(r, 20));
		await markWhatsNewSeenLogic(a, [WHATS_NEW_ENTRIES[0].id]);
		const [after] = await testDb
			.select({ updatedAt: user.updatedAt })
			.from(user)
			.where(eq(user.id, a));
		expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
	});

	it("a feature seen is recorded once, per user", async () => {
		const a = await makeUser();
		const b = await makeUser();
		await markFeatureSeenLogic(a, "account");
		// Idempotent: the unique index turns a second use into a no-op.
		await markFeatureSeenLogic(a, "account");
		expect((await loadWhatsNewState(a)).featuresSeen).toEqual(["account"]);
		expect((await loadWhatsNewState(b)).featuresSeen).toEqual([]);
		const rows = await testDb
			.select()
			.from(userFeatureSeen)
			.where(eq(userFeatureSeen.userId, a));
		expect(rows.length).toBe(1);
	});

	it("a feature key no longer in FEATURE_KEYS is dropped on read", async () => {
		const a = await makeUser();
		await testDb
			.insert(userFeatureSeen)
			.values({ userId: a, featureKey: "retired-key" });
		expect((await loadWhatsNewState(a)).featuresSeen).toEqual([]);
	});

	it("user_feature_seen rows cascade with their user row (FK ON DELETE CASCADE)", async () => {
		const a = await makeUser();
		await markFeatureSeenLogic(a, "account");
		await testDb.delete(user).where(eq(user.id, a));
		const rows = await testDb
			.select()
			.from(userFeatureSeen)
			.where(eq(userFeatureSeen.userId, a));
		expect(rows).toEqual([]);
	});
});
