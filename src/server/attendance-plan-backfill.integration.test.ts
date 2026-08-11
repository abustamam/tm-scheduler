/**
 * Verifies the backfill SQL that moves member_availability + meeting_outreach
 * rows into meeting_attendance_plan, by running the SHIPPED statements (imported
 * from the same constant the migration was written from) against seeded legacy
 * rows. Deleted in Task 7 with the tables it exercises.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-backfill.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	meetingAttendancePlan,
	meetingOutreach,
	memberAvailability,
} from "#/db/schema";
import { BACKFILL_PLAN_SQL } from "#/server/attendance-plan-backfill";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

describe.skipIf(!hasTestDb)("planned-attendance backfill", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function planFor(memberId: string) {
		const rows = await testDb
			.select({ status: meetingAttendancePlan.status })
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, memberId));
		return rows[0]?.status ?? null;
	}

	it("maps availability → not_coming, outreach-only → reached_out, both → not_coming", async () => {
		const onlyAvail = club.memberId;
		const onlyOutreach = club.adminMemberId;
		const bothPersonId = await seedPerson({ name: "Both Member" });
		const both = randomUUID();
		await testDb.execute(sql`
			INSERT INTO members (id, club_id, person_id, name, status, club_role)
			VALUES (${both}, ${club.clubId}, ${bothPersonId}, 'Both Member', 'active', 'member')`);

		await testDb.insert(memberAvailability).values([
			{ memberId: onlyAvail, meetingId: club.meetingId },
			{ memberId: both, meetingId: club.meetingId },
		]);
		await testDb.insert(meetingOutreach).values([
			{ memberId: onlyOutreach, meetingId: club.meetingId },
			{ memberId: both, meetingId: club.meetingId },
		]);

		await testDb.execute(sql.raw(BACKFILL_PLAN_SQL));

		expect(await planFor(onlyAvail)).toBe("not_coming");
		expect(await planFor(onlyOutreach)).toBe("reached_out");
		// not_coming wins; the "we asked them" fact is deliberately discarded.
		expect(await planFor(both)).toBe("not_coming");
	});

	it("leaves a member with neither legacy row with no plan row", async () => {
		await testDb.execute(sql.raw(BACKFILL_PLAN_SQL));
		expect(await planFor(club.memberId)).toBe(null);
	});
});
