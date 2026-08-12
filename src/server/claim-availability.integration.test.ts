/**
 * DB-backed integration tests for the self-claim attendance answer (spec
 * 2026-07-13, re-pointed onto the ladder by D6 2026-08-11): claiming or
 * reassigning a role for YOURSELF records you as `coming` for that meeting;
 * admin assignments (actor ≠ member, or no actor) leave the member's own answer
 * untouched.
 *
 * Before the consolidation this DELETED the member's `member_availability` row,
 * so "coming" and "no answer" were the same absent row. The assertions below
 * therefore check the row's STATUS, not its existence — an assertion that a row
 * exists would now pass for `not_coming` too, i.e. for the exact regression
 * these tests exist to catch.
 *
 * Exercises the REAL slots-logic helpers; `#/db` is mocked to the test client
 * so importing slots-logic doesn't require a DATABASE_URL (same pattern as
 * reassign.integration.test.ts). Skips cleanly when TEST_DATABASE_URL is
 * unset. Run with:
 *   TEST_DATABASE_URL=postgresql://...tm_test \
 *     bunx vitest run src/server/claim-availability.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingAttendancePlan,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** The member's rung for the meeting, or null for "no answer" (no row). */
async function planStatus(
	memberId: string,
	meetingId: string,
): Promise<string | null> {
	const [row] = await testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, meetingId),
			),
		)
		.limit(1);
	return row?.status ?? null;
}

async function planSetLogRows(clubId: string, meetingId: string) {
	return testDb
		.select({ id: activityLog.id, detail: activityLog.detail })
		.from(activityLog)
		.where(
			and(
				eq(activityLog.clubId, clubId),
				eq(activityLog.action, "plan_set"),
				eq(activityLog.targetId, meetingId),
			),
		);
}

/** Seed the answer directly (not through the seam) so the activity assertions
 *  below see only the rows the code under test wrote. */
async function seedNotComing(memberId: string, meetingId: string) {
	await testDb
		.insert(meetingAttendancePlan)
		.values({ memberId, meetingId, status: "not_coming" });
}

describe.skipIf(!hasTestDb)("self-claim records the member as coming", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// The member has already said they can't make the seeded meeting.
		await seedNotComing(seed.memberId, seed.meetingId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("self-claim (member === actor) flips not_coming to coming", async () => {
		const { markComingOnSelfClaim } = await import("./slots-logic");
		await markComingOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await planStatus(seed.memberId, seed.meetingId)).toBe("coming");
	});

	it("admin assignment (member !== actor) leaves the member's not_coming", async () => {
		const { markComingOnSelfClaim } = await import("./slots-logic");
		await markComingOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await planStatus(seed.memberId, seed.meetingId)).toBe("not_coming");
	});

	it("no actor (null) leaves the member's not_coming", async () => {
		const { markComingOnSelfClaim } = await import("./slots-logic");
		await markComingOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: null,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await planStatus(seed.memberId, seed.meetingId)).toBe("not_coming");
	});

	// -------------------------------------------------------------------------
	// Activity. The implicit answer inside markComingOnSelfClaim logs the same
	// `plan_set` the explicit writers do (#211 logged an `availability_clear`
	// here), carrying the rung it set — the feed reads "said they're coming".
	// -------------------------------------------------------------------------

	it("self-claim logs a plan_set carrying the coming status", async () => {
		const { markComingOnSelfClaim } = await import("./slots-logic");
		await markComingOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		const rows = await planSetLogRows(seed.clubId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.detail).toMatchObject({
			memberId: seed.memberId,
			status: "coming",
		});
	});

	it("an admin assignment logs nothing at all", async () => {
		const { markComingOnSelfClaim } = await import("./slots-logic");
		await markComingOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await planSetLogRows(seed.clubId, seed.meetingId)).toHaveLength(0);
	});

	it("self-claim with NO prior answer still records coming", async () => {
		const { markComingOnSelfClaim } = await import("./slots-logic");
		// DELIBERATE behaviour change (D6). The old code deleted the decline row
		// and, per #211, logged only when it actually deleted one — a claimant with
		// no row wrote nothing. "Coming" is now information worth keeping rather
		// than the absence of a decline, so it is recorded either way.
		await testDb
			.delete(meetingAttendancePlan)
			.where(
				and(
					eq(meetingAttendancePlan.memberId, seed.memberId),
					eq(meetingAttendancePlan.meetingId, seed.meetingId),
				),
			);
		await markComingOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await planStatus(seed.memberId, seed.meetingId)).toBe("coming");
		expect(await planSetLogRows(seed.clubId, seed.meetingId)).toHaveLength(1);
	});

	it("reassignSlotCore self-takeover records coming end-to-end", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.memberId,
			}),
		);
		const [slot] = await testDb
			.select({ assignedMemberId: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);
		expect(slot?.assignedMemberId).toBe(seed.memberId);
		expect(await planStatus(seed.memberId, seed.meetingId)).toBe("coming");
	});

	it("reassignSlotCore admin-assign leaves the member's not_coming", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			}),
		);
		expect(await planStatus(seed.memberId, seed.meetingId)).toBe("not_coming");
	});
});

// -----------------------------------------------------------------------------
// #212 — attachSpeechToOpenSlot (the rescheduleSpeech flow) applies the same
// self-only rule: scheduling a speech into an open slot for the ACTOR
// themselves records them coming; an admin scheduling someone else's speech
// (a different member's) must NOT speak for that member.
// -----------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"speech attach onto an open slot records the speaker as coming (#212)",
	() => {
		let seed: SeededClub;
		let speakerRoleId: string;

		beforeEach(async () => {
			seed = await seedClub();
			// The member has already said they can't make the seeded meeting.
			await seedNotComing(seed.memberId, seed.meetingId);
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			speakerRoleId = def!.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		async function seedOpenSpeakerSlot(): Promise<string> {
			const [row] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: speakerRoleId,
					slotIndex: 1,
					status: "open",
				})
				.returning({ id: roleSlots.id });
			return row!.id;
		}

		async function seedSpeech(
			personId: string,
			title: string,
		): Promise<string> {
			const [row] = await testDb
				.insert(speeches)
				.values({ personId, title })
				.returning({ id: speeches.id });
			return row!.id;
		}

		it("self attach (actor === the speech owner's membership) records the actor coming", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			const slotId = await seedOpenSpeakerSlot();
			const speechId = await seedSpeech(seed.personId, "My Icebreaker");

			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId,
				actorMemberId: seed.memberId,
			});

			expect(await planStatus(seed.memberId, seed.meetingId)).toBe("coming");
		});

		it("admin attach for someone else's speech leaves that member's not_coming", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			const slotId = await seedOpenSpeakerSlot();
			const speechId = await seedSpeech(seed.personId, "My Icebreaker");

			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId,
				actorMemberId: seed.adminMemberId,
			});

			expect(await planStatus(seed.memberId, seed.meetingId)).toBe(
				"not_coming",
			);
		});
	},
);
