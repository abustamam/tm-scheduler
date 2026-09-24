/**
 * DB-backed tests for `listEffectiveComingForMeeting` (#664): the seam's reader
 * for "who is coming?" by the same rule the officer's rail shows, so a server
 * consumer no longer gets a smaller answer than the officer is looking at.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-effective-coming.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	meetingAttendancePlan,
	meetings,
	members,
	people,
	roleSlots,
} from "#/db/schema";
import {
	listComingForMeeting,
	listEffectiveComingForMeeting,
} from "#/server/attendance-plan-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

describe.skipIf(!hasTestDb)("listEffectiveComingForMeeting", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function addMember(name: string): Promise<string> {
		const [person] = await testDb
			.insert(people)
			.values({ name })
			.returning({ id: people.id });
		if (!person) throw new Error("person insert failed");
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: person.id,
				name,
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!m) throw new Error("member insert failed");
		return m.id;
	}

	async function addSlot(
		assignedMemberId: string,
		status: "claimed" | "confirmed",
		slotIndex: number,
		meetingId = club.meetingId,
	) {
		await testDb.insert(roleSlots).values({
			meetingId,
			roleDefinitionId: club.roleDefinitionId,
			slotIndex,
			assignedMemberId,
			status,
		});
	}

	it("adds a confirmed role-holder with no answer, flagged assumed", async () => {
		// The seeded member answered; the admin holds a confirmed slot and never did.
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "coming",
		});
		await addSlot(club.adminMemberId, "confirmed", 1);

		const effective = await listEffectiveComingForMeeting(
			testDb,
			club.meetingId,
		);
		expect(effective).toEqual(
			[
				{ memberId: club.memberId, assumed: false },
				{ memberId: club.adminMemberId, assumed: true },
			].sort((a, b) => a.memberId.localeCompare(b.memberId)),
		);
		// The stored-only reader is deliberately unchanged — that is what keeps
		// every existing caller's answer from moving silently.
		expect(await listComingForMeeting(testDb, club.meetingId)).toEqual([
			club.memberId,
		]);
	});

	it("lets an explicit not_coming outrank a confirmed slot", async () => {
		await addSlot(club.memberId, "confirmed", 1);
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "not_coming",
		});
		expect(await listEffectiveComingForMeeting(testDb, club.meetingId)).toEqual(
			[],
		);
	});

	it("lets a confirmed slot outrank a stored reached_out", async () => {
		// The officer messaged a confirmed Toastmaster: the ask inserts
		// `reached_out`, and they must not fall back out of the coming set.
		await addSlot(club.memberId, "confirmed", 1);
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "reached_out",
		});
		expect(await listEffectiveComingForMeeting(testDb, club.meetingId)).toEqual(
			[{ memberId: club.memberId, assumed: true }],
		);
	});

	it("does not infer from a CLAIMED (unconfirmed) slot", async () => {
		await addSlot(club.memberId, "claimed", 1);
		expect(await listEffectiveComingForMeeting(testDb, club.meetingId)).toEqual(
			[],
		);
	});

	it("reports a member holding two confirmed slots once", async () => {
		await addSlot(club.memberId, "confirmed", 1);
		await addSlot(club.memberId, "confirmed", 2);
		expect(await listEffectiveComingForMeeting(testDb, club.meetingId)).toEqual(
			[{ memberId: club.memberId, assumed: true }],
		);
	});

	it("is scoped to the one meeting", async () => {
		const other = await addMember("Other Meeting Holder");
		const [otherMeeting] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		if (!otherMeeting) throw new Error("meeting insert failed");
		await addSlot(other, "confirmed", 0, otherMeeting.id);
		await testDb.insert(meetingAttendancePlan).values({
			memberId: other,
			meetingId: otherMeeting.id,
			status: "coming",
		});

		expect(await listEffectiveComingForMeeting(testDb, club.meetingId)).toEqual(
			[],
		);
		expect(
			await listEffectiveComingForMeeting(testDb, otherMeeting.id),
		).toEqual([{ memberId: other, assumed: false }]);
	});
});
