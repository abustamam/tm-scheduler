/**
 * DB-backed tests for loadActivity (the enrichment/filtering behind the VPE
 * activity feed). Activity rows are inserted directly via logActivity so we
 * test the read path without the Start runtime; `#/db` is redirected to the
 * test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/activity-feed.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import { logActivity } from "#/server/activity";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("loadActivity", () => {
	let seed: SeededClub;
	let member2Id: string;

	beforeEach(async () => {
		seed = await seedClub();
		const [m2] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, name: "Member Two" })
			.returning({ id: members.id });
		member2Id = m2.id;
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function seedActivity() {
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: seed.memberId,
			action: "claim",
			targetType: "slot",
			targetId: seed.slotId,
			detail: { memberId: seed.memberId },
		});
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: member2Id,
			action: "reassign",
			targetType: "slot",
			targetId: seed.slotId,
			detail: { fromMemberId: seed.memberId, memberId: member2Id },
		});
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: seed.memberId,
			action: "availability_set",
			targetType: "meeting",
			targetId: seed.meetingId,
		});
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: member2Id,
			action: "member_add",
			targetType: "member",
			targetId: member2Id,
			detail: { name: "Member Two" },
		});
	}

	it("returns enriched rows newest-first with names/role/meeting resolved", async () => {
		await seedActivity();
		const { loadActivity } = await import("#/server/activity-feed-logic");
		const rows = await loadActivity({ clubId: seed.clubId });
		expect(rows.length).toBe(4);
		for (let i = 1; i < rows.length; i++) {
			expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
				rows[i].createdAt.getTime(),
			);
		}
		const reassign = rows.find((r) => r.action === "reassign");
		expect(reassign?.roleName).toBeTruthy();
		expect(reassign?.meetingId).toBe(seed.meetingId);
		expect(reassign?.subjectName).toBe("Member Two");
		expect(reassign?.fromName).toBeTruthy(); // displaced member resolved (Task 1)

		const add = rows.find((r) => r.action === "member_add");
		expect(add?.subjectName).toBe("Member Two");
		expect(add?.meetingId).toBeNull();
	});

	it("meeting filter excludes member_add, keeps slot + availability rows", async () => {
		await seedActivity();
		const { loadActivity } = await import("#/server/activity-feed-logic");
		const rows = await loadActivity({
			clubId: seed.clubId,
			meetingId: seed.meetingId,
		});
		expect(rows.some((r) => r.action === "member_add")).toBe(false);
		expect(rows.some((r) => r.action === "availability_set")).toBe(true);
		expect(rows.some((r) => r.action === "reassign")).toBe(true);
	});

	it("actor filter returns only that member's actions", async () => {
		await seedActivity();
		const { loadActivity } = await import("#/server/activity-feed-logic");
		const rows = await loadActivity({
			clubId: seed.clubId,
			actorMemberId: seed.memberId,
		});
		expect(rows.length).toBe(2);
		expect(
			rows.every((r) => ["claim", "availability_set"].includes(r.action)),
		).toBe(true);
	});
});
