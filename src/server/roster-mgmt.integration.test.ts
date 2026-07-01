/**
 * DB-backed tests for the VPE roster management fns (edit/merge/remove). Tests
 * the plain `applyX` fns directly (the createServerFn wrappers need the Start
 * runtime); `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/roster-mgmt.integration.test.ts
 */
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	memberAvailability,
	members,
	roleSlots,
} from "#/db/schema";
import { logActivity } from "#/server/activity";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function addMemberRow(clubId: string, name: string) {
	const [m] = await testDb
		.insert(members)
		.values({ clubId, name })
		.returning({ id: members.id });
	return m.id;
}

describe.skipIf(!hasTestDb)("roster management", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("editMember updates fields + logs member_edit", async () => {
		const { applyMemberEdit } = await import("#/server/members-logic");
		await applyMemberEdit({
			clubId: seed.clubId,
			actorMemberId: seed.memberId,
			memberId: seed.memberId,
			name: "Renamed",
			email: "a@b.co",
			phone: null,
			office: "VP Education",
		});
		const [m] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, seed.memberId));
		expect(m.name).toBe("Renamed");
		expect(m.office).toBe("VP Education");
		const [log] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "member_edit"),
					eq(activityLog.targetId, seed.memberId),
				),
			)
			.limit(1);
		expect(log).toBeTruthy();
	});

	it("mergeMembers re-points slots, availability, and history then deletes B", async () => {
		const { applyMemberMerge } = await import("#/server/members-logic");
		const keeper = seed.memberId;
		const absorbed = await addMemberRow(seed.clubId, "Dupe");
		// B holds the slot, has availability, and has activity history.
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: absorbed, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
		await testDb
			.insert(memberAvailability)
			.values({ memberId: absorbed, meetingId: seed.meetingId });
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: absorbed,
			action: "claim",
			targetType: "slot",
			targetId: seed.slotId,
			detail: { memberId: absorbed },
		});
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: keeper,
			action: "reassign",
			targetType: "slot",
			targetId: seed.slotId,
			detail: { fromMemberId: absorbed, memberId: keeper },
		});

		await applyMemberMerge({
			clubId: seed.clubId,
			keeperId: keeper,
			absorbedId: absorbed,
			actorMemberId: keeper,
		});

		// B is gone.
		const bRows = await testDb
			.select()
			.from(members)
			.where(eq(members.id, absorbed));
		expect(bRows.length).toBe(0);
		// Slot now keeper's.
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot.assignedMemberId).toBe(keeper);
		// Availability moved.
		const avail = await testDb
			.select()
			.from(memberAvailability)
			.where(eq(memberAvailability.memberId, absorbed));
		expect(avail.length).toBe(0);
		// History re-attributed: no rows still reference B as actor.
		const bActor = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.actorMemberId, absorbed));
		expect(bActor.length).toBe(0);
		// detail.fromMemberId rewritten to keeper.
		const [reassign] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "reassign"),
					eq(activityLog.clubId, seed.clubId),
				),
			)
			.orderBy(desc(activityLog.createdAt))
			.limit(1);
		expect((reassign.detail as { fromMemberId?: string }).fromMemberId).toBe(
			keeper,
		);
		// member_merge logged.
		const merge = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.action, "member_merge"));
		expect(merge.length).toBe(1);
	});

	it("mergeMembers rejects absorbing a signed-in (user-linked) member", async () => {
		const { applyMemberMerge } = await import("#/server/members-logic");
		const absorbed = await addMemberRow(seed.clubId, "Linked");
		await testDb
			.update(members)
			.set({ userId: seed.adminUserId })
			.where(eq(members.id, absorbed));
		await expect(
			applyMemberMerge({
				clubId: seed.clubId,
				keeperId: seed.memberId,
				absorbedId: absorbed,
				actorMemberId: seed.memberId,
			}),
		).rejects.toThrow();
	});

	it("mergeMembers rejects keeper === absorbed", async () => {
		const { applyMemberMerge } = await import("#/server/members-logic");
		await expect(
			applyMemberMerge({
				clubId: seed.clubId,
				keeperId: seed.memberId,
				absorbedId: seed.memberId,
			}),
		).rejects.toThrow();
	});

	it("removeMember releases upcoming roles then deletes the member", async () => {
		const { applyMemberRemove } = await import("#/server/members-logic");
		const victim = await addMemberRow(seed.clubId, "Leaving");
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: victim, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		await applyMemberRemove({
			clubId: seed.clubId,
			memberId: victim,
			actorMemberId: null,
		});

		// Slot released.
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot.status).toBe("open");
		expect(slot.assignedMemberId).toBeNull();
		// release logged with the displaced member.
		const [rel] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "release"),
					eq(activityLog.targetId, seed.slotId),
				),
			)
			.orderBy(desc(activityLog.createdAt))
			.limit(1);
		expect((rel.detail as { fromMemberId?: string }).fromMemberId).toBe(victim);
		// Member gone + member_remove logged.
		const vRows = await testDb
			.select()
			.from(members)
			.where(eq(members.id, victim));
		expect(vRows.length).toBe(0);
		const removed = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "member_remove"),
					eq(activityLog.targetId, victim),
				),
			);
		expect(removed.length).toBe(1);
	});

	it("removeMember rejects a signed-in (user-linked) member", async () => {
		const { applyMemberRemove } = await import("#/server/members-logic");
		await testDb
			.update(members)
			.set({ userId: seed.adminUserId })
			.where(eq(members.id, seed.memberId));
		await expect(
			applyMemberRemove({ clubId: seed.clubId, memberId: seed.memberId }),
		).rejects.toThrow();
	});
});
