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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * No DB needed — pure text comparison, so it runs even without TEST_DATABASE_URL
 * set (unlike the describe block below). This is the enforcement for the claim
 * in attendance-plan-backfill.ts's doc comment that the migration and the
 * constant cannot diverge: without this, editing one file and not the other
 * breaks that premise with every other test in this file still green, because
 * they only ever execute the TS constant and never read the shipped migration.
 */
describe("BACKFILL_PLAN_SQL / migration file parity", () => {
	it("keeps drizzle/0061_backfill_attendance_plan.sql identical to BACKFILL_PLAN_SQL, modulo the statement-breakpoint marker", () => {
		const migrationPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"drizzle",
			"0061_backfill_attendance_plan.sql",
		);
		const migrationSql = readFileSync(migrationPath, "utf8");
		// The migration spells the statement separator as a breakpoint marker line;
		// the constant spells it as a blank line. Collapsing one into the other is
		// the ONLY normalization applied — everything else must match byte-for-byte.
		const migrationNormalized = migrationSql
			.replace(/\n--> statement-breakpoint\n/g, "\n\n")
			.trim();
		expect(migrationNormalized).toBe(BACKFILL_PLAN_SQL.trim());
	});
});

describe.skipIf(!hasTestDb)("planned-attendance backfill", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function planRowFor(memberId: string) {
		const rows = await testDb
			.select({
				status: meetingAttendancePlan.status,
				createdAt: meetingAttendancePlan.createdAt,
				updatedAt: meetingAttendancePlan.updatedAt,
			})
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, memberId));
		return rows[0] ?? null;
	}

	async function planFor(memberId: string) {
		return (await planRowFor(memberId))?.status ?? null;
	}

	it("maps availability → not_coming, outreach-only → reached_out, both → not_coming", async () => {
		const onlyAvail = club.memberId;
		const onlyOutreach = club.adminMemberId;
		const bothPersonId = await seedPerson({ name: "Both Member" });
		const both = randomUUID();
		await testDb.execute(sql`
			INSERT INTO members (id, club_id, person_id, name, status, club_role)
			VALUES (${both}, ${club.clubId}, ${bothPersonId}, 'Both Member', 'active', 'member')`);

		// Distinct, clearly-historical timestamps per legacy row so the backfill's
		// column mapping (created_at/updated_at sourced from the LEGACY row's
		// created_at, not left at migration-time now()) has real coverage, and so
		// the "both" case proves the winning not_coming row takes ITS timestamp
		// from member_availability.created_at, not from meeting_outreach.created_at.
		const availTime = new Date("2024-03-01T10:00:00.000Z");
		const outreachTime = new Date("2024-05-10T14:30:00.000Z");
		const bothAvailTime = new Date("2024-06-20T09:15:00.000Z");
		const bothOutreachTime = new Date("2024-08-01T00:00:00.000Z");

		await testDb.insert(memberAvailability).values([
			{ memberId: onlyAvail, meetingId: club.meetingId, createdAt: availTime },
			{ memberId: both, meetingId: club.meetingId, createdAt: bothAvailTime },
		]);
		await testDb.insert(meetingOutreach).values([
			{
				memberId: onlyOutreach,
				meetingId: club.meetingId,
				createdAt: outreachTime,
			},
			{
				memberId: both,
				meetingId: club.meetingId,
				createdAt: bothOutreachTime,
			},
		]);

		await testDb.execute(sql.raw(BACKFILL_PLAN_SQL));

		const availRow = await planRowFor(onlyAvail);
		expect(availRow?.status).toBe("not_coming");
		expect(availRow?.createdAt.getTime()).toBe(availTime.getTime());
		expect(availRow?.updatedAt.getTime()).toBe(availTime.getTime());

		const outreachRow = await planRowFor(onlyOutreach);
		expect(outreachRow?.status).toBe("reached_out");
		expect(outreachRow?.createdAt.getTime()).toBe(outreachTime.getTime());
		expect(outreachRow?.updatedAt.getTime()).toBe(outreachTime.getTime());

		// not_coming wins; the "we asked them" fact is deliberately discarded, and
		// so is its timestamp — the surviving row's created_at/updated_at come from
		// member_availability (bothAvailTime), never from meeting_outreach
		// (bothOutreachTime).
		const bothRow = await planRowFor(both);
		expect(bothRow?.status).toBe("not_coming");
		expect(bothRow?.createdAt.getTime()).toBe(bothAvailTime.getTime());
		expect(bothRow?.updatedAt.getTime()).toBe(bothAvailTime.getTime());
	});

	it("leaves a member with neither legacy row with no plan row", async () => {
		await testDb.execute(sql.raw(BACKFILL_PLAN_SQL));
		expect(await planFor(club.memberId)).toBe(null);
	});
});
