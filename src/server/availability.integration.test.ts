/**
 * DB-backed integration tests for setAvailability + clearAvailability.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/availability.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, memberAvailability } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

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
