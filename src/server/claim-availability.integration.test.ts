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
import { memberAvailability, roleSlots } from "#/db/schema";
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
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(false);
	});

	it("admin assignment (member !== actor) leaves the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			meetingId: seed.meetingId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});

	it("no actor (null) leaves the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: null,
			meetingId: seed.meetingId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
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
