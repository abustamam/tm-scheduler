/**
 * DB-backed integration tests for the self-claim NA-clear (spec 2026-07-13):
 * claiming/reassigning a role for YOURSELF deletes your member_availability
 * ("not going") row for that meeting; admin assignments (actor ≠ member, or
 * no actor) leave the member's own absence statement intact.
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
	memberAvailability,
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

async function naRowExists(memberId: string, meetingId: string) {
	const rows = await testDb
		.select({ id: memberAvailability.id })
		.from(memberAvailability)
		.where(
			and(
				eq(memberAvailability.memberId, memberId),
				eq(memberAvailability.meetingId, meetingId),
			),
		);
	return rows.length > 0;
}

async function availabilityClearLogRows(clubId: string, meetingId: string) {
	return testDb
		.select({ id: activityLog.id, detail: activityLog.detail })
		.from(activityLog)
		.where(
			and(
				eq(activityLog.clubId, clubId),
				eq(activityLog.action, "availability_clear"),
				eq(activityLog.targetId, meetingId),
			),
		);
}

describe.skipIf(!hasTestDb)("self-claim clears the decline flag", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// The member has declined the seeded meeting.
		await testDb
			.insert(memberAvailability)
			.values({ memberId: seed.memberId, meetingId: seed.meetingId });
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("self-claim (member === actor) deletes the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(false);
	});

	it("admin assignment (member !== actor) leaves the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});

	it("no actor (null) leaves the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: null,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// #211 — the implicit clear inside clearAvailabilityOnSelfClaim logs an
	// `availability_clear` activity (matching the explicit clearAvailability
	// server fn in availability.ts), but only when a row was actually deleted —
	// don't spam the feed on every claim of a member with no NA row.
	// -------------------------------------------------------------------------

	it("self-claim with a pre-existing NA row logs an availability_clear activity", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		const rows = await availabilityClearLogRows(seed.clubId, seed.meetingId);
		expect(rows).toHaveLength(1);
	});

	it("self-claim with NO pre-existing NA row logs nothing", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		// Clear the seeded NA row first so there's nothing to delete.
		await testDb
			.delete(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, seed.memberId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		const rows = await availabilityClearLogRows(seed.clubId, seed.meetingId);
		expect(rows).toHaveLength(0);
	});

	it("reassignSlotCore self-takeover clears the NA row end-to-end", async () => {
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
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(false);
	});

	it("reassignSlotCore admin-assign leaves the NA row", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			}),
		);
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});
});

// -----------------------------------------------------------------------------
// #212 — attachSpeechToOpenSlot (the rescheduleSpeech flow) applies the same
// self-only rule: scheduling a speech into an open slot for the ACTOR
// themselves clears their own NA row; an admin scheduling someone else's
// speech (a different member's) must NOT touch that member's absence
// statement.
// -----------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"speech attach onto an open slot clears the decline flag (#212)",
	() => {
		let seed: SeededClub;
		let speakerRoleId: string;

		beforeEach(async () => {
			seed = await seedClub();
			// The member has declined the seeded meeting.
			await testDb
				.insert(memberAvailability)
				.values({ memberId: seed.memberId, meetingId: seed.meetingId });
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

		it("self attach (actor === the speech owner's membership) clears the actor's NA row", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			const slotId = await seedOpenSpeakerSlot();
			const speechId = await seedSpeech(seed.personId, "My Icebreaker");

			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId,
				actorMemberId: seed.memberId,
			});

			expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(false);
		});

		it("admin attach for someone else's speech leaves that member's NA row", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			const slotId = await seedOpenSpeakerSlot();
			const speechId = await seedSpeech(seed.personId, "My Icebreaker");

			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId,
				actorMemberId: seed.adminMemberId,
			});

			expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
		});
	},
);
