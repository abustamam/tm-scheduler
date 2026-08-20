/**
 * DB-backed integration tests for setAvailability + clearAvailability, and for
 * `releaseSlotsAndMarkUnavailable` (#204).
 *
 * "Not available" is now the `not_coming` rung of `meeting_attendance_plan`
 * (D6, 2026-08-11), not the presence of a `member_availability` row, so every
 * assertion here checks the STATUS: a row-exists assertion would pass for
 * `coming` too.
 *
 * HONEST LIMITATION on the first block. A `createServerFn` handler cannot be
 * invoked in vitest, so the two helpers below reproduce what the (now delegating)
 * handlers do rather than calling them. They exercise the real seam, but they
 * cannot see a delegate that passes the WRONG rung — the two writers whose
 * mapping is load-bearing and testable are `releaseSlotsAndMarkUnavailable`
 * below and `markComingOnSelfClaim` (claim-availability.integration.test.ts),
 * which are called directly. PR 2 deletes the delegates entirely.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/availability.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, meetingAttendancePlan, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import {
	clearPlanStatus,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "./attendance-plan-logic";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";

// ---------------------------------------------------------------------------
// Helpers — mirror the delegating handler bodies against testDb
// ---------------------------------------------------------------------------

async function setAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
) {
	await setPlanStatus(testDb, {
		memberId,
		meetingId,
		clubId,
		status: "not_coming",
		actorMemberId: memberId,
	});
	return { ok: true as const };
}

async function clearAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
) {
	await clearPlanStatus(testDb, {
		memberId,
		meetingId,
		clubId,
		actorMemberId: memberId,
		// Mirrors what `clearAvailability` actually passes. This helper omitted it
		// while `onlyFrom` was optional, so it modelled an UNFLOORED delete that the
		// production fn has never performed — every assertion made through it about
		// officer state was proving the wrong thing (#573).
		onlyFrom: SELF_SERVICE_RUNGS,
	});
	return { ok: true as const };
}

async function planRows(memberId: string, meetingId: string) {
	return testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, meetingId),
			),
		);
}

async function planSetLogs(meetingId: string) {
	return testDb
		.select({
			actorMemberId: activityLog.actorMemberId,
			detail: activityLog.detail,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.targetId, meetingId),
				eq(activityLog.action, "plan_set"),
			),
		)
		.orderBy(activityLog.createdAt);
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

	it("setAvailability records not_coming and logs plan_set carrying that rung", async () => {
		const result = await setAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
		);
		expect(result).toEqual({ ok: true });

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");

		const log = await planSetLogs(seed.meetingId);
		expect(log).toHaveLength(1);
		// The rung lives in the detail, not the action name — an assertion on the
		// action alone cannot tell "not coming" from "coming".
		expect(log[0]?.detail).toMatchObject({
			memberId: seed.memberId,
			status: "not_coming",
		});
	});

	it("setAvailability is idempotent (the seam upserts)", async () => {
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);
		// Second call should not throw
		await expect(
			setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).resolves.toEqual({ ok: true });

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");
	});

	it("clearAvailability removes the row (back to no answer) and logs a null rung", async () => {
		// Set first
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);

		// Clear
		const result = await clearAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
		);
		expect(result).toEqual({ ok: true });

		expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);

		// A clear is a plan_set with a NULL rung — matched on the detail rather
		// than on position, so the assertion does not depend on row order.
		const log = await planSetLogs(seed.meetingId);
		expect(log).toHaveLength(2);
		const cleared = log.filter(
			(l) => (l.detail as { status?: unknown } | null)?.status === null,
		);
		expect(cleared).toHaveLength(1);
		expect(cleared[0]?.detail).toMatchObject({
			memberId: seed.memberId,
			status: null,
		});
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

	it("releases the member's held slots AND records not_coming, atomically", async () => {
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

		// The answer is "not coming" — NOT merely "a plan row exists", which a
		// `coming` row would satisfy while meaning the opposite.
		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");

		// Logged both a release (for the slot) and plan_set (for the meeting).
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
		const setLogs = await planSetLogs(seed.meetingId);
		expect(setLogs).toHaveLength(1);
		expect(setLogs[0]?.detail).toMatchObject({ status: "not_coming" });
	});

	it("records not_coming even when the member holds no roles (released = 0)", async () => {
		const result = await releaseSlotsAndMarkUnavailable(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(result.released).toBe(0);

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");
	});

	it("attributes an officer's action to the officer, with the member as subject", async () => {
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: seed.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));

		// Officer (adminMemberId) marks the member (memberId) unavailable.
		await releaseSlotsAndMarkUnavailable(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});

		const [setLog] = await planSetLogs(seed.meetingId);
		// Actor = the officer; subject (detail.memberId) = the target member.
		expect(setLog?.actorMemberId).toBe(seed.adminMemberId);
		expect((setLog?.detail as { memberId?: string })?.memberId).toBe(
			seed.memberId,
		);

		// The released-slot log is likewise attributed to the officer.
		const [relLog] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.slotId),
					eq(activityLog.action, "release"),
				),
			)
			.limit(1);
		expect(relLog?.actorMemberId).toBe(seed.adminMemberId);
	});
});
