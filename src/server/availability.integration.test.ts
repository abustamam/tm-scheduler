/**
 * DB-backed integration tests for setAvailability + clearAvailability.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/availability.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, memberAvailability, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";

// ---------------------------------------------------------------------------
// Helpers — replicate the availability query logic using testDb
// ---------------------------------------------------------------------------

async function setAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
) {
	await testDb
		.insert(memberAvailability)
		.values({ memberId, meetingId })
		.onConflictDoNothing();

	await testDb.insert(activityLog).values({
		clubId,
		actorMemberId: memberId,
		action: "availability_set",
		targetType: "meeting",
		targetId: meetingId,
	});

	return { ok: true as const };
}

async function clearAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
) {
	await testDb
		.delete(memberAvailability)
		.where(
			and(
				eq(memberAvailability.memberId, memberId),
				eq(memberAvailability.meetingId, meetingId),
			),
		);

	await testDb.insert(activityLog).values({
		clubId,
		actorMemberId: memberId,
		action: "availability_clear",
		targetType: "meeting",
		targetId: meetingId,
	});

	return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("availability (set + clear)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("setAvailability inserts a row (presence = not available) and logs availability_set", async () => {
		const result = await setAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
		);
		expect(result).toEqual({ ok: true });

		// Row inserted
		const [row] = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, seed.memberId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			)
			.limit(1);

		expect(row).toBeDefined();
		expect(row?.memberId).toBe(seed.memberId);
		expect(row?.meetingId).toBe(seed.meetingId);

		// Activity log row
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "availability_set"),
				),
			);
		expect(log.length).toBeGreaterThan(0);
	});

	it("setAvailability is idempotent (onConflictDoNothing)", async () => {
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);
		// Second call should not throw
		await expect(
			setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).resolves.toEqual({ ok: true });

		// Still only one row in memberAvailability
		const rows = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, seed.memberId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);

		expect(rows).toHaveLength(1);
	});

	it("clearAvailability removes the row and logs availability_clear", async () => {
		// Set first
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);

		// Clear
		const result = await clearAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
		);
		expect(result).toEqual({ ok: true });

		// Row gone
		const rows = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, seed.memberId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);

		expect(rows).toHaveLength(0);

		// Activity log row for clear
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "availability_clear"),
				),
			);
		expect(log.length).toBeGreaterThan(0);
	});

	it("clearAvailability on non-existent row is a no-op (no error)", async () => {
		await expect(
			clearAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).resolves.toEqual({ ok: true });
	});
});

describe.skipIf(!hasTestDb)("releaseSlotsAndMarkUnavailable (#204)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("releases the member's held slots AND marks them unavailable, atomically", async () => {
		// Assign the seeded (open) slot to the member.
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: seed.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));

		const result = await releaseSlotsAndMarkUnavailable(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(result.released).toBe(1);

		// Slot is back to open and unassigned.
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);
		expect(slot?.assignedMemberId).toBeNull();
		expect(slot?.status).toBe("open");

		// Availability row present.
		const avail = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, seed.memberId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);
		expect(avail).toHaveLength(1);

		// Logged both a release (for the slot) and availability_set (for the meeting).
		const relLogs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.slotId),
					eq(activityLog.action, "release"),
				),
			);
		expect(relLogs.length).toBeGreaterThan(0);
		const setLogs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "availability_set"),
				),
			);
		expect(setLogs.length).toBeGreaterThan(0);
	});

	it("marks unavailable even when the member holds no roles (released = 0)", async () => {
		const result = await releaseSlotsAndMarkUnavailable(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(result.released).toBe(0);

		const avail = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, seed.memberId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);
		expect(avail).toHaveLength(1);
	});
});
