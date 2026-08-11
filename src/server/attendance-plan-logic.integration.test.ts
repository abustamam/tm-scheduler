/**
 * DB-backed tests for the meeting_attendance_plan store.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-logic.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meetingAttendancePlan } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

describe.skipIf(!hasTestDb)("meeting_attendance_plan table", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("stores each of the three statuses", async () => {
		for (const status of ["reached_out", "coming", "not_coming"] as const) {
			await testDb
				.insert(meetingAttendancePlan)
				.values({
					memberId: club.memberId,
					meetingId: club.meetingId,
					status,
				})
				.onConflictDoUpdate({
					target: [
						meetingAttendancePlan.memberId,
						meetingAttendancePlan.meetingId,
					],
					set: { status },
				});
			const [row] = await testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, club.memberId),
						eq(meetingAttendancePlan.meetingId, club.meetingId),
					),
				);
			expect(row?.status).toBe(status);
		}
	});

	it("allows at most one row per (member, meeting)", async () => {
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "coming",
		});
		await expect(
			testDb.insert(meetingAttendancePlan).values({
				memberId: club.memberId,
				meetingId: club.meetingId,
				status: "not_coming",
			}),
		).rejects.toThrow();
	});
});
