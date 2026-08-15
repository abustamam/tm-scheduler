/**
 * Executes the REAL backfill migration (`drizzle/0061_backfill_attendance_plan.sql`)
 * against data and asserts the rung each member lands on.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-backfill.integration.test.ts
 *
 * ## Why this file exists
 *
 * Nothing else executes that SQL with rows in it. CI applies migrations to an
 * EMPTY database, so both `INSERT … SELECT` statements copy zero rows and pass
 * vacuously; `tm_test` is `db:push`-synced and skips the migration path
 * entirely. The backfill was therefore unverified in exactly the way that
 * matters — and `0062` drops both source tables in the same transaction, so a
 * wrong precedence is not recoverable afterwards. It converts a real decline
 * into `reached_out`, which the season grid then reads as available.
 *
 * ## Why it rebuilds the legacy tables instead of migrating
 *
 * The two source tables no longer exist in `schema.ts` — this PR drops them — so
 * there is no drizzle symbol to insert through and no fixture that can create
 * them. They are recreated here from the DDL of the migrations that made them
 * (`0000` for `member_availability`, `0044` for `meeting_outreach`), reduced to
 * the four columns the backfill actually reads. Dropped in `afterEach` so the
 * pushed schema is left exactly as found.
 *
 * The SQL is READ FROM DISK rather than restated. A copy would drift from the
 * migration silently and this file would then be testing itself.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meetingAttendancePlan } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

const BACKFILL_SQL = readFileSync(
	"drizzle/0061_backfill_attendance_plan.sql",
	"utf8",
);

/** The shape the backfill reads: (member_id, meeting_id, created_at). */
const LEGACY_DDL = `
	CREATE TABLE IF NOT EXISTS member_availability (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		member_id uuid NOT NULL,
		meeting_id uuid NOT NULL,
		created_at timestamp DEFAULT now() NOT NULL
	);
	CREATE TABLE IF NOT EXISTS meeting_outreach (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		member_id uuid NOT NULL,
		meeting_id uuid NOT NULL,
		created_at timestamp DEFAULT now() NOT NULL
	);
`;

/** Drizzle's runner splits on this marker; `sql.raw` takes one statement. */
async function runMigrationSql(text: string): Promise<void> {
	for (const statement of text.split("--> statement-breakpoint")) {
		const trimmed = statement.trim();
		if (trimmed.length > 0) await testDb.execute(sql.raw(trimmed));
	}
}

describe.skipIf(!hasTestDb)("0061 attendance-plan backfill", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		await runMigrationSql(LEGACY_DDL);
		await testDb.execute(sql`DELETE FROM member_availability`);
		await testDb.execute(sql`DELETE FROM meeting_outreach`);
	});

	afterEach(async () => {
		await testDb.execute(sql`DROP TABLE IF EXISTS member_availability`);
		await testDb.execute(sql`DROP TABLE IF EXISTS meeting_outreach`);
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function planRows() {
		const rows = await testDb
			.select({
				memberId: meetingAttendancePlan.memberId,
				status: meetingAttendancePlan.status,
				createdAt: meetingAttendancePlan.createdAt,
				updatedAt: meetingAttendancePlan.updatedAt,
			})
			.from(meetingAttendancePlan);
		return new Map(rows.map((r) => [r.memberId, r]));
	}

	it("maps every shape to the right rung, and a decline outranks an ask", async () => {
		const { memberId: declinedOnly, adminMemberId: both } = club;
		// Two members is all `seedClub` gives, and the interesting case needs both
		// tables populated for ONE of them — so `both` carries the overlap and
		// `declinedOnly` carries the availability-only case. The outreach-only case
		// gets its own test below, where the member is free.
		await testDb.execute(sql`
			INSERT INTO member_availability (member_id, meeting_id, created_at)
			VALUES (${declinedOnly}, ${club.meetingId}, '2026-01-01 10:00'),
			       (${both}, ${club.meetingId}, '2026-01-03 10:00')`);
		await testDb.execute(sql`
			INSERT INTO meeting_outreach (member_id, meeting_id, created_at)
			VALUES (${both}, ${club.meetingId}, '2026-01-04 10:00')`);

		await runMigrationSql(BACKFILL_SQL);
		const rows = await planRows();

		expect(rows.get(declinedOnly)?.status).toBe("not_coming");
		// THE precedence assertion. A member who was contacted AND said they
		// cannot come must land on the answer, not the ask. Backwards, and an
		// officer's outreach mark would overwrite a real decline at deploy time —
		// silently, and with the source table dropped moments later.
		expect(rows.get(both)?.status).toBe("not_coming");
		expect(rows.size).toBe(2);
	});

	it("carries an outreach-only member across as reached_out", async () => {
		await testDb.execute(sql`
			INSERT INTO meeting_outreach (member_id, meeting_id, created_at)
			VALUES (${club.memberId}, ${club.meetingId}, '2026-01-02 10:00')`);

		await runMigrationSql(BACKFILL_SQL);
		const rows = await planRows();

		expect(rows.get(club.memberId)?.status).toBe("reached_out");
	});

	it("leaves a member in neither table with no row — 'no answer'", async () => {
		await runMigrationSql(BACKFILL_SQL);
		expect((await planRows()).size).toBe(0);
	});

	it("preserves created_at and backdates updated_at to match it", async () => {
		// `updated_at` defaults to now(), so without the explicit column list in the
		// migration every backfilled row would claim it was touched at deploy time.
		await testDb.execute(sql`
			INSERT INTO member_availability (member_id, meeting_id, created_at)
			VALUES (${club.memberId}, ${club.meetingId}, '2026-01-01 10:00')`);

		await runMigrationSql(BACKFILL_SQL);
		const row = (await planRows()).get(club.memberId);

		expect(row?.createdAt?.toISOString()).toBe(
			new Date("2026-01-01T10:00:00Z").toISOString(),
		);
		expect(row?.updatedAt?.toISOString()).toBe(row?.createdAt?.toISOString());
	});

	it("collapses duplicate source rows to one, keeping the earliest", async () => {
		// The live tables carry a unique index on (member_id, meeting_id) so this
		// cannot happen there — which is exactly why the `ON CONFLICT DO NOTHING`
		// looks removable. It is the only thing standing between a corrupted source
		// table and a migration that aborts the whole deploy on a unique violation.
		await testDb.execute(sql`
			INSERT INTO meeting_outreach (member_id, meeting_id, created_at)
			VALUES (${club.memberId}, ${club.meetingId}, '2026-01-05 10:00'),
			       (${club.memberId}, ${club.meetingId}, '2026-01-06 10:00')`);

		await runMigrationSql(BACKFILL_SQL);
		const rows = await planRows();

		expect(rows.size).toBe(1);
		expect(rows.get(club.memberId)?.createdAt?.toISOString()).toBe(
			new Date("2026-01-05T10:00:00Z").toISOString(),
		);
	});
});
