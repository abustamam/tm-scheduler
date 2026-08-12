# Planned Attendance — PR 1: Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two disconnected booleans `meeting_outreach` and `member_availability` with a single `meeting_attendance_plan` status ladder, with **zero visual change** to the app.

**Architecture:** One new table holds `reached_out | coming | not_coming` per `(member, meeting)`; row absence means "no answer". A single db seam (`attendance-plan-logic.ts`) is the only module that touches it. The five existing server fns (`setAvailability`, `clearAvailability`, `markUnavailableReleasing`, `setContacted`, `clearContacted`) are rewritten as thin delegates onto that seam so no client file changes in this PR. Every reader that meant "row exists ⇒ unavailable" gains `status = 'not_coming'`.

**Tech Stack:** Drizzle ORM on Postgres (`pg` / node-postgres), TanStack Start `createServerFn`, Vitest, Biome, Bun.

**Spec:** `docs/superpowers/specs/2026-08-11-planned-attendance-design.md` (D1, D6; Testing items 1, 3, 8).

**Worktree:** `/media/rasheed-bustamam/Extra/coding/tm-planned-attendance`, branch `feat/planned-attendance`. All paths below are relative to it.

---

## Before you start

Export the test database URL in every shell you run tests in. Without it ~630 integration tests **silently skip** and the run still reads green:

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"
```

The local Postgres is the already-running `dev-postgres` Docker container. Do **not** `docker run` a new one — it collides on port 5432.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` *(modify)* | `attendancePlanStatusEnum`, `meetingAttendancePlan` table, `plan_set` activity action |
| `drizzle/XXXX_*.sql` *(generated + hand-edited)* | create enum + table, then backfill from the two old tables |
| `drizzle/YYYY_*.sql` *(generated)* | drop `meeting_outreach` and `member_availability` |
| `src/server/attendance-plan-logic.ts` *(create)* | **the only module that reads or writes the new table.** Pure db logic, no `#/db` import of its own — takes a `database` argument so tests can pass `testDb` |
| `src/server/attendance-plan.ts` *(create)* | `setPlannedAttendance` / `clearPlannedAttendance` server fns + their authz |
| `src/server/availability.ts` *(modify)* | the three fns become delegates onto the seam |
| `src/server/outreach.ts` *(modify)* | the two fns become delegates onto the seam |
| `src/server/availability-logic.ts` *(modify)* | `releaseSlotsAndMarkUnavailable` writes `not_coming` |
| `src/server/slots-logic.ts` *(modify)* | `clearAvailabilityOnSelfClaim` writes `coming` |
| `src/server/meetings.ts` *(modify)* | loader reads the plan table for both `unavailableMembers` and `contactedMemberIds` |
| `src/server/season-grid-logic.ts` *(modify)* | one query replaces two |
| `src/server/recurrence-rule-logic.ts` *(modify)* | "has anyone touched this meeting" reads the plan table |
| `src/server/membership-collapse-logic.ts` *(modify)* | merge re-points plan rows |
| `src/lib/activity-format.ts` *(modify)* | render the `plan_set` action |
| `src/server/attendance-plan-store.guard.test.ts` *(create)* | no source file outside the seam may name the plan table; no file may name the dropped tables |

**Why a seam.** `server-modules.guard.test.ts` enforces that a module defining a `createServerFn` exports **only** server fns and types — a top-level db-touching export in the same file drags `#/db` → `pg` → `Buffer` into the browser bundle and white-screens the page. So all db logic lives in `*-logic.ts`, which client code never imports.

---

## Task 1: Schema — enum, table, activity action

**Files:**
- Modify: `src/db/schema.ts`
- Test: `src/server/attendance-plan-logic.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/attendance-plan-logic.integration.test.ts`:

```ts
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
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

describe.skipIf(!hasTestDb)("meeting_attendance_plan table", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(cleanup);

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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/attendance-plan-logic.integration.test.ts
```

Expected: FAIL — `meetingAttendancePlan` is not exported from `#/db/schema`.

- [ ] **Step 3: Add the enum to `src/db/schema.ts`**

Directly beneath `attendanceStatusEnum` (currently around line 147):

```ts
// Planned attendance for an UPCOMING meeting (D1 of the 2026-08-11 spec).
// Replaces two disconnected booleans: `meeting_outreach` ("I asked them") and
// `member_availability` ("not available"). Row ABSENT = "no answer" — silence
// and a positive answer used to be indistinguishable, which is why `coming`
// exists at all. Deliberately NOT `attendance_status`: that one is the RECORD
// (present/absent/excused) written after the meeting, and a plan must never be
// storable as a record. See `meeting_attendance` below.
export const attendancePlanStatusEnum = pgEnum("attendance_plan_status", [
	"reached_out",
	"coming",
	"not_coming",
]);
```

- [ ] **Step 4: Add the table to `src/db/schema.ts`**

**Add** this immediately after the existing `meetingOutreach` block (currently ending around line 915). **Leave `memberAvailability` and `meetingOutreach` exactly where they are** — eight modules still import them and every intermediate commit has to typecheck. They are removed in Task 7, once nothing references them.

```ts
// ---------------------------------------------------------------------------
// Planned attendance — one row per (member, meeting) carrying where the outreach
// got to. Supersedes `member_availability` (row = not available) and
// `meeting_outreach` (row = contacted), both dropped later in the same PR: they
// answered overlapping questions and could disagree, and neither could express
// "she replied, she's coming". `not_coming` is the ONLY encoding of "unavailable"
// in the database — every reader that used to test for a `member_availability`
// row now tests `status = 'not_coming'`.
// ---------------------------------------------------------------------------

export const meetingAttendancePlan = pgTable(
	"meeting_attendance_plan",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		status: attendancePlanStatusEnum("status").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		// Plain unique index (not a composite PK) so ON CONFLICT can infer it as
		// an arbiter for the upsert in `setPlanStatus`.
		uniqueIndex("meeting_attendance_plan_unique").on(t.memberId, t.meetingId),
		index("meeting_attendance_plan_meeting_idx").on(t.meetingId),
	],
);
```

- [ ] **Step 5: Add the `plan_set` activity action**

In `activityActionEnum` (around line 92), replace the `availability_set` / `availability_clear` and `outreach_set` / `outreach_clear` entries' comments and add the new action. Keep all four old strings in the enum — historical rows still carry them and the feed must keep rendering:

```ts
	// Legacy planned-attendance actions. NO LONGER EMITTED as of the
	// meeting_attendance_plan consolidation — kept in the enum so historical
	// activity_log rows still render. New writes use `plan_set`.
	"availability_set",
	"availability_clear",
	...
	"outreach_set",
	"outreach_clear",
	// Planned attendance changed (spec 2026-08-11, D1). One action for every
	// rung of the ladder; the rung is in the detail, not the action name.
	// `detail = { memberId, status: "reached_out" | "coming" | "not_coming" | null, via }`
	// where `status: null` means the row was cleared back to "no answer".
	"plan_set",
```

- [ ] **Step 6: Generate the migration**

```bash
bun run db:generate
```

Expected: one new file in `drizzle/` creating the `attendance_plan_status` enum, the `meeting_attendance_plan` table, and adding `plan_set` to `activity_action`. It must contain **no** `DROP TABLE` — the old tables are still declared in `schema.ts` and stay until Task 7. If a `DROP TABLE` appears, Step 4 deleted a block it was told to leave; restore it and regenerate.

- [ ] **Step 7: Apply the migration to both databases**

```bash
bun run db:migrate
DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run db:push --force
```

`tm_test` is the one database `db:push` is for. Never `db:push` the dev database — it diverges the migration-tracking table.

- [ ] **Step 8: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/attendance-plan-logic.integration.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 9: Verify nothing else broke**

```bash
bun run typecheck
```

Expected: no errors. The old tables are still declared and still imported by eight modules, so this must stay clean at every commit in this PR.

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts drizzle/ src/server/attendance-plan-logic.integration.test.ts
git commit -m "feat(db): add meeting_attendance_plan table and plan_set action"
```

---

## Task 2: Backfill the new table from the two old ones

**Files:**
- Create: `drizzle/XXXX_backfill_attendance_plan.sql` via `drizzle-kit generate --custom`
- Create: `src/server/attendance-plan-backfill.ts`, `src/server/attendance-plan-backfill.integration.test.ts`

**Do not edit the Task 1 migration.** It has already been applied to the dev database and drizzle records applied migrations by file hash; editing it in place means the backfill never runs locally and the recorded hash no longer matches the file. The backfill goes in its own migration.

**The test uses the real legacy tables, which still exist.** They are not dropped until Task 7, and a `CREATE TEMP TABLE` alternative would be worse than useless here: `testDb` is a node-postgres **pool**, so a temp table created on one connection is invisible to the next query, and an `IF EXISTS` drop in teardown would then hit the real table. Task 7 deletes this test file along with the tables it exercises — a backfill is a one-shot migration and its verification is one-shot too.

- [ ] **Step 1: Write the failing test**

Create `src/server/attendance-plan-backfill.integration.test.ts`:

```ts
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
	memberAvailability,
	meetingOutreach,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import { BACKFILL_PLAN_SQL } from "#/server/attendance-plan-backfill";

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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/attendance-plan-backfill.integration.test.ts
```

Expected: FAIL — cannot resolve `#/server/attendance-plan-backfill`.

- [ ] **Step 3: Create the shared backfill SQL constant**

Create `src/server/attendance-plan-backfill.ts`. It exports a string, imports nothing, and touches no database — so it is safe for both the migration author and the test to read, and a change to one cannot silently diverge from the other:

```ts
/**
 * The exact backfill applied by the `meeting_attendance_plan` migration, kept as
 * a constant so `attendance-plan-backfill.integration.test.ts` verifies the SQL
 * that actually shipped rather than a paraphrase of it. No imports: this file is
 * read by a test and pasted into a migration, nothing more.
 *
 * Precedence: `not_coming` beats `reached_out`. A member who was contacted AND
 * marked unavailable loses the "we asked them" fact, which is invisible today —
 * the old `deriveOutreach` filtered unavailable members out of both its lists.
 *
 * Both statements are `ON CONFLICT DO NOTHING`, which makes the backfill
 * idempotent (safe to re-run against a partially populated table) and keeps the
 * precedence above from depending on statement order alone.
 */
export const BACKFILL_PLAN_SQL = `
INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
SELECT a.member_id, a.meeting_id, 'not_coming', a.created_at
FROM member_availability a
ON CONFLICT (member_id, meeting_id) DO NOTHING;

INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
SELECT o.member_id, o.meeting_id, 'reached_out', o.created_at
FROM meeting_outreach o
WHERE NOT EXISTS (
  SELECT 1 FROM member_availability a
  WHERE a.member_id = o.member_id AND a.meeting_id = o.meeting_id
)
ON CONFLICT (member_id, meeting_id) DO NOTHING;
`;
```

- [ ] **Step 4: Create an empty migration and paste the backfill into it**

```bash
bunx drizzle-kit generate --custom --name backfill_attendance_plan
```

That writes an empty `drizzle/00XX_backfill_attendance_plan.sql` plus its journal entry. Paste the two statements from `BACKFILL_PLAN_SQL` into it, separated by drizzle's statement breakpoint:

```sql
INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
SELECT a.member_id, a.meeting_id, 'not_coming', a.created_at
FROM member_availability a
ON CONFLICT (member_id, meeting_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
SELECT o.member_id, o.meeting_id, 'reached_out', o.created_at
FROM meeting_outreach o
WHERE NOT EXISTS (
  SELECT 1 FROM member_availability a
  WHERE a.member_id = o.member_id AND a.meeting_id = o.meeting_id
)
ON CONFLICT (member_id, meeting_id) DO NOTHING;
```

The SQL here must be byte-identical to `BACKFILL_PLAN_SQL` apart from the breakpoint marker — that identity is the entire reason the constant exists.

Do **not** use `CREATE INDEX CONCURRENTLY` anywhere in this file — it cannot run inside drizzle's migration transaction and the deploy fails closed.

- [ ] **Step 5: Apply it**

```bash
bun run db:migrate
```

Expected: the new migration applies. The dev database has real legacy rows, so confirm the backfill actually moved them:

```bash
docker exec dev-postgres psql -U dev -d tm_scheduler -c \
  "select status, count(*) from meeting_attendance_plan group by status"
```

Compare against `select count(*) from member_availability` and `select count(*) from meeting_outreach` on the same database. The `not_coming` count must equal the availability count exactly; `reached_out` must equal the outreach count minus any rows that also had an availability row.

- [ ] **Step 6: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/attendance-plan-backfill.integration.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add drizzle/ src/server/attendance-plan-backfill.ts src/server/attendance-plan-backfill.integration.test.ts
git commit -m "feat(db): backfill meeting_attendance_plan from availability + outreach"
```

---

## Task 3: The db seam

**Files:**
- Create: `src/server/attendance-plan-logic.ts`
- Test: `src/server/attendance-plan-logic.integration.test.ts` (extend from Task 1)

- [ ] **Step 1: Write the failing tests**

Append to `src/server/attendance-plan-logic.integration.test.ts` (add `activityLog` to the `#/db/schema` import and the seam functions to the imports):

```ts
describe.skipIf(!hasTestDb)("attendance-plan seam", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(cleanup);

	it("upserts rather than duplicating on a second write", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "reached_out",
			actorMemberId: club.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, club.memberId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("coming");
	});

	it("clearing removes the row entirely, not sets a status", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, club.memberId));
		expect(rows).toHaveLength(0);
	});

	it("logs plan_set with the status in the detail", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
			via: "manual",
		});
		const [entry] = await testDb
			.select({ action: activityLog.action, detail: activityLog.detail })
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.action).toBe("plan_set");
		expect(entry?.detail).toMatchObject({
			memberId: club.memberId,
			status: "coming",
			via: "manual",
		});
	});

	it("logs a clear as plan_set with a null status", async () => {
		await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const [entry] = await testDb
			.select({ action: activityLog.action, detail: activityLog.detail })
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.action).toBe("plan_set");
		expect(entry?.detail).toMatchObject({ status: null });
	});

	it("listNotComingForMeetings returns ONLY not_coming rows", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: club.adminMemberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: club.adminMemberId,
		});
		const out = await listNotComingForMeetings(testDb, [club.meetingId]);
		expect(out).toEqual([
			{ memberId: club.adminMemberId, meetingId: club.meetingId },
		]);
	});

	it("listNotComingForMeetings skips the round-trip on an empty id list", async () => {
		const spy = vi.spyOn(testDb, "select");
		const out = await listNotComingForMeetings(testDb, []);
		expect(out).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
```

Add `vi` to the `vitest` import. That last test asserts the **observable the guard controls** — an empty `inArray` compiles to `false` in Drizzle, so a result-only assertion passes whether the short-circuit runs or not and cannot fail.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/attendance-plan-logic.integration.test.ts
```

Expected: FAIL — cannot resolve `#/server/attendance-plan-logic`.

- [ ] **Step 3: Create the seam**

Create `src/server/attendance-plan-logic.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { db } from "#/db";
import { meetingAttendancePlan, members } from "#/db/schema";
import { logActivity } from "./activity";

type Database = typeof db;
/** Accepts a transaction too — `releaseSlotsAndMarkUnavailable` writes inside one. */
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AttendancePlanStatus = "reached_out" | "coming" | "not_coming";

/**
 * THE only module that reads or writes `meeting_attendance_plan`. Row absent =
 * "no answer"; there is no fourth enum value for it, because a row that means
 * "nothing is known" is a row every reader has to remember to ignore.
 *
 * `not_coming` is the sole encoding of "unavailable" in the database. Anything
 * asking "is this member out?" MUST come through here rather than testing for
 * row presence — the whole point of the consolidation is that presence no
 * longer answers that question.
 */
export async function setPlanStatus(
	database: DbOrTx,
	args: {
		memberId: string;
		meetingId: string;
		clubId: string;
		status: AttendancePlanStatus;
		/** Null is a decision, not an omission: an impersonated write resolves to
		 *  null and `logActivity` stamps the real superadmin for it. */
		actorMemberId: string | null;
		/** How the change happened. Recorded in the activity detail only. */
		via?: "nudge" | "manual";
	},
): Promise<{ ok: true }> {
	await database
		.insert(meetingAttendancePlan)
		.values({
			memberId: args.memberId,
			meetingId: args.meetingId,
			status: args.status,
		})
		.onConflictDoUpdate({
			target: [meetingAttendancePlan.memberId, meetingAttendancePlan.meetingId],
			set: { status: args.status, updatedAt: new Date() },
		});

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: {
			memberId: args.memberId,
			status: args.status,
			via: args.via ?? "manual",
		},
	});
	return { ok: true as const };
}

/** Back to "no answer" — deletes the row. Idempotent. */
export async function clearPlanStatus(
	database: DbOrTx,
	args: {
		memberId: string;
		meetingId: string;
		clubId: string;
		actorMemberId: string | null;
	},
): Promise<{ ok: true }> {
	await database
		.delete(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, args.memberId),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
			),
		);

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId, status: null },
	});
	return { ok: true as const };
}

/** Members marked `not_coming`, with names, for one meeting — ordered by name. */
export async function listNotComingWithNames(
	database: DbOrTx,
	meetingId: string,
): Promise<{ id: string; name: string }[]> {
	return database
		.select({ id: members.id, name: members.name })
		.from(meetingAttendancePlan)
		.innerJoin(members, eq(members.id, meetingAttendancePlan.memberId))
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		)
		.orderBy(members.name);
}

/** `not_coming` pairs across several meetings (season grid, recurrence check). */
export async function listNotComingForMeetings(
	database: DbOrTx,
	meetingIds: string[],
): Promise<{ memberId: string; meetingId: string }[]> {
	// Short-circuit: an empty `inArray` compiles to `false`, so this guard exists
	// to skip the round-trip, not to change the result.
	if (meetingIds.length === 0) return [];
	return database
		.select({
			memberId: meetingAttendancePlan.memberId,
			meetingId: meetingAttendancePlan.meetingId,
		})
		.from(meetingAttendancePlan)
		.where(
			and(
				inArray(meetingAttendancePlan.meetingId, meetingIds),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		);
}

/** Every plan row across several meetings, statuses included — the season grid
 *  needs both partitions from one round-trip. */
export async function listPlanForMeetings(
	database: DbOrTx,
	meetingIds: string[],
): Promise<
	{ memberId: string; meetingId: string; status: AttendancePlanStatus }[]
> {
	if (meetingIds.length === 0) return [];
	return database
		.select({
			memberId: meetingAttendancePlan.memberId,
			meetingId: meetingAttendancePlan.meetingId,
			status: meetingAttendancePlan.status,
		})
		.from(meetingAttendancePlan)
		.where(inArray(meetingAttendancePlan.meetingId, meetingIds));
}

/** `reached_out` member ids for one meeting — the old "contacted" set. */
export async function listReachedOutForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	const rows = await database
		.select({ memberId: meetingAttendancePlan.memberId })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, "reached_out"),
			),
		);
	return rows.map((r) => r.memberId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/attendance-plan-logic.integration.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/attendance-plan-logic.ts src/server/attendance-plan-logic.integration.test.ts
git commit -m "feat(server): add attendance-plan db seam"
```

---

## Task 4: Render the `plan_set` activity action

**Files:**
- Modify: `src/lib/activity-format.ts`
- Test: `src/lib/activity-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/activity-format.test.ts`, following the shape of the existing `availability_set` cases in that file:

```ts
describe("plan_set", () => {
	it("reads as self-service when the subject is the actor", () => {
		expect(
			formatActivity({
				action: "plan_set",
				actorName: "Ana Reyes",
				subjectName: "Ana Reyes",
				detail: { status: "coming" },
			}),
		).toContain("said they're coming");
	});

	it("names the subject when an officer sets it", () => {
		expect(
			formatActivity({
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				detail: { status: "not_coming" },
			}),
		).toContain("marked Ana Reyes as not coming");
	});

	it("renders reached_out", () => {
		expect(
			formatActivity({
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				detail: { status: "reached_out" },
			}),
		).toContain("reached out to Ana Reyes");
	});

	it("renders a cleared plan", () => {
		expect(
			formatActivity({
				action: "plan_set",
				actorName: "Dev Patel",
				subjectName: "Ana Reyes",
				detail: { status: null },
			}),
		).toContain("cleared Ana Reyes's planned attendance");
	});
});
```

Match the exact call signature and helper name used by the existing tests in that file — read the top of `src/lib/activity-format.test.ts` first and mirror it; the entry shape above is illustrative of the fields, not necessarily the exact object the existing helper takes.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bunx vitest run src/lib/activity-format.test.ts
```

Expected: FAIL — `plan_set` falls through to the default summary.

- [ ] **Step 3: Add the case**

In `src/lib/activity-format.ts`, immediately after the `outreach_clear` case (around line 56):

```ts
		case "plan_set": {
			// One action for every rung; the rung is in the detail. The four legacy
			// actions above still have cases because historical rows carry them.
			const status = (entry.detail as { status?: string | null } | null)?.status ?? null;
			const subject = entry.subjectName ?? "someone";
			const isSelf = entry.subjectName != null && entry.subjectName === actor;
			if (status === null) {
				summary = isSelf
					? "cleared their planned attendance"
					: `cleared ${subject}'s planned attendance`;
			} else if (status === "coming") {
				summary = isSelf ? "said they're coming" : `marked ${subject} as coming`;
			} else if (status === "not_coming") {
				summary = isSelf
					? "said they can't make it"
					: `marked ${subject} as not coming`;
			} else {
				summary = `reached out to ${subject}`;
			}
			break;
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bunx vitest run src/lib/activity-format.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity-format.ts src/lib/activity-format.test.ts
git commit -m "feat(activity): render plan_set entries"
```

---

## Task 5: Cut the writers over

This is one coherent commit: after it, nothing writes the old tables. Each step is one file.

**Files:**
- Create: `src/server/attendance-plan.ts`
- Modify: `src/server/availability.ts`, `src/server/outreach.ts`, `src/server/availability-logic.ts`, `src/server/slots-logic.ts`
- Test: `src/server/attendance-plan-authz.guard.test.ts` (create), plus existing `availability.integration.test.ts`, `outreach.integration.test.ts`, `claim-availability.integration.test.ts`

- [ ] **Step 1: Write the failing authz test**

Create `src/server/attendance-plan-authz.guard.test.ts`, modelled on the existing `src/server/outreach-authz.guard.test.ts` — read that file first and mirror its structure. It must assert, by reading the source of `src/server/attendance-plan.ts` via `#/test/guard-source`:

```ts
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = readSource("src/server/attendance-plan.ts");

describe("attendance-plan authz", () => {
	it("gates every officer write on requireClubRole(admin)", () => {
		expect(SRC).toContain('requireClubRole(user.id, meeting.clubId, ["admin"])');
	});

	it("derives the club from the meeting, never from the payload", () => {
		// #396: gating on a client-supplied clubId lets an admin of club A act on
		// club B's meeting and file the row under A.
		expect(SRC).toContain("await loadMeeting(data.meetingId)");
		expect(SRC).not.toContain("requireClubRole(user.id, data.clubId");
	});

	it("rejects a member setting someone else's row", () => {
		expect(SRC).toContain("SELF_ONLY_MESSAGE");
	});

	it("asserts the meeting is not locked", () => {
		expect(SRC).toContain("assertMeetingNotLocked(meeting.status)");
	});

	it("gates the session-less path on the club's archived_at", () => {
		expect(SRC).toContain("assertClubNotArchived");
	});
});
```

`readSource` reads comment-blind, which is required here: several assertions are "this pattern must BE present", and a comment merely naming the pattern would make them falsely pass.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bunx vitest run src/server/attendance-plan-authz.guard.test.ts
```

Expected: FAIL — `src/server/attendance-plan.ts` does not exist.

- [ ] **Step 3: Create `src/server/attendance-plan.ts`**

```ts
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	clearPlanStatus,
	setPlanStatus,
} from "./attendance-plan-logic";
import { assertClubNotArchived } from "./club-readable-logic";
import { requireMemberInClub, requireUser } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { requestWriteActor } from "./write-actor-logic";

export const SELF_ONLY_MESSAGE =
	"You can only change your own planned attendance.";

/** Meeting status + OWNING club. The club comes from the meeting, never the
 *  payload (#396): gating on a client-supplied `clubId` would let an admin of
 *  club A act on club B's meeting and file the row under A. */
async function loadMeeting(
	meetingId: string,
): Promise<{ status: string; clubId: string }> {
	const [row] = await db
		.select({ status: meetings.status, clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row;
}

const planSchema = z.object({
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	/** Who performed it. Omitted ⇒ self-service. PUBLIC path, so this is an
	 *  assertion, not proof — `requestWriteActor` club-scopes it and a real
	 *  session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	status: z.enum(["reached_out", "coming", "not_coming"]),
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/**
 * Resolve the acting member and enforce D6: an officer may set anyone's row, a
 * member may set only their own. Session-less by design — the anonymous
 * roster-pick identity is the dominant path in this product — so it also gates
 * on `clubs.archived_at`, which the other session-less writers still miss
 * (#555). Returns the actor id to attribute the write to.
 */
async function resolveActor(args: {
	clubId: string;
	memberId: string;
	claimedActorMemberId?: string;
}): Promise<string | null> {
	await assertClubNotArchived(args.clubId);
	const user = await requireUser().catch(() => null);
	if (user) {
		const membership = await requireClubRole(user.id, args.clubId, [
			"admin",
		]).catch(() => null);
		if (membership) return membership.id;
	}
	const actor = await requestWriteActor({
		clubId: args.clubId,
		claimedActorMemberId: args.claimedActorMemberId ?? args.memberId,
	});
	if (actor !== args.memberId) throw new Error(SELF_ONLY_MESSAGE);
	return actor;
}

/** Set a member's planned attendance for a meeting. */
export const setPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) => planSchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await resolveActor({
			clubId: meeting.clubId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		return setPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			status: data.status,
			actorMemberId,
			via: data.via,
		});
	});

/** Clear a member's planned attendance back to "no answer". */
export const clearPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) => planSchema.omit({ status: true, via: true }).parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await resolveActor({
			clubId: meeting.clubId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		return clearPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId,
		});
	});
```

Add `requireClubRole` to the `./guards` import. If `assertClubNotArchived` does not already exist in `src/server/club-readable-logic.ts`, add it there as a thin wrapper that throws when `clubs.archived_at` is non-null, and export it — the file already holds `isReadableClub` and friends.

- [ ] **Step 4: Run the authz test to verify it passes**

```bash
bunx vitest run src/server/attendance-plan-authz.guard.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite `src/server/availability.ts` as delegates**

Keep all three exported names — no client file changes in this PR. Replace each handler body's db work with the seam. `setAvailability` becomes:

```ts
			await setPlanStatus(db, {
				memberId: data.memberId,
				meetingId: data.meetingId,
				clubId: meeting.clubId,
				status: "not_coming",
				actorMemberId,
			});
			return { ok: true as const };
```

`clearAvailability` becomes `await clearPlanStatus(db, { ... })` with the same four arguments. Delete the now-unused `memberAvailability` import and the `logActivity` calls (the seam logs). Add a file-header note:

```ts
// Legacy entry points, retained so PR 1 changes no client file. They are thin
// delegates onto `attendance-plan-logic` and are deleted in PR 2 when the panel
// calls `setPlannedAttendance` directly.
```

- [ ] **Step 6: Rewrite `src/server/outreach.ts` as delegates**

`setContacted` → `setPlanStatus(db, { ..., status: "reached_out", via: data.via })`.
`clearContacted` → `clearPlanStatus(db, { ... })`. Same header note as Step 5. Delete the `meetingOutreach` and `logActivity` imports.

Note the behavioural nuance to preserve: `clearContacted` previously deleted only the outreach row. It now clears the whole plan row, so clearing "contacted" on a member who is `not_coming` would wipe that too. It cannot happen through the UI — `deriveOutreach` never lists an unavailable member, so no checkbox exists for them — but state it in a comment so the next reader does not have to re-derive it.

- [ ] **Step 7: Rewrite `releaseSlotsAndMarkUnavailable` in `src/server/availability-logic.ts`**

Replace the `insert(memberAvailability)…onConflictDoNothing()` block (currently around line 55 of that file) with:

```ts
		await setPlanStatus(tx, {
			memberId: args.memberId,
			meetingId: args.meetingId,
			clubId: args.clubId,
			status: "not_coming",
			actorMemberId,
		});
```

It runs inside the existing transaction, which is why the seam accepts `DbOrTx`. Drop the `memberAvailability` import.

- [ ] **Step 8: Rewrite `clearAvailabilityOnSelfClaim` in `src/server/slots-logic.ts`**

Claiming a role now records `coming` rather than deleting the row — more truthful, and it is the behaviour the panel will render in PR 2. Replace the `delete(memberAvailability)…returning()` block (around line 886) with:

```ts
	// Claiming a role IS a statement that you're coming. This used to delete the
	// availability row, which threw the information away; recording `coming`
	// keeps it and is what the planned-attendance panel renders.
	await setPlanStatus(tx, {
		memberId: args.memberId,
		meetingId: args.meetingId,
		clubId: args.clubId,
		status: "coming",
		actorMemberId: args.memberId,
	});
```

Rename the function to `markComingOnSelfClaim` and update its call sites (`rg -n "clearAvailabilityOnSelfClaim" src/`). Keep the existing early return — it still only fires for a genuine self-claim:

```ts
	if (args.actorMemberId === null || args.memberId !== args.actorMemberId)
		return;
```

- [ ] **Step 9: Update the three affected integration suites**

`availability.integration.test.ts`, `outreach.integration.test.ts` and `claim-availability.integration.test.ts` assert against the old tables and the old activity actions. Repoint each to `meetingAttendancePlan` and `plan_set`. In `claim-availability.integration.test.ts`, the assertion that the availability row is **gone** after a self-claim becomes an assertion that the row's status is `coming`.

- [ ] **Step 10: Run the affected suites**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/availability.integration.test.ts \
    src/server/outreach.integration.test.ts \
    src/server/claim-availability.integration.test.ts \
    src/server/attendance-plan-authz.guard.test.ts \
    src/server/slots-logic.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/server/
git commit -m "feat(server): write planned attendance instead of availability + outreach"
```

---

## Task 6: Cut the readers over, one failing test each

Every reader below currently means "row exists ⇒ unavailable". **No existing fixture contains a row that isn't `not_coming`**, so each reader gets a fixture member marked `coming` first — that test fails against the unfiltered reader, which is the only way this task can prove it did anything.

**Files:**
- Modify: `src/server/meetings.ts`, `src/server/season-grid-logic.ts`, `src/server/recurrence-rule-logic.ts`, `src/server/membership-collapse-logic.ts`
- Test: `src/server/season-grid.integration.test.ts`, `src/server/recurrence-rule.integration.test.ts`, `src/server/membership-collapse-logic.integration.test.ts`, `src/server/public-reads.integration.test.ts`

- [ ] **Step 1: Write the failing fixture assertions**

Each suite seeds **two extra plan rows** — one `coming`, one `reached_out` — and asserts the reader ignores them. The insert shape is identical everywhere; only the loader call differs, so copy each suite's existing invocation of that loader rather than inventing one.

`season-grid.integration.test.ts`:

```ts
	it("treats only not_coming as unavailable", async () => {
		await testDb.insert(meetingAttendancePlan).values([
			{ memberId: club.memberId, meetingId: club.meetingId, status: "coming" },
			{ memberId: club.adminMemberId, meetingId: club.meetingId, status: "reached_out" },
		]);
		const data = await loadSeasonGridData({ clubId: club.clubId, includeOutreach: true });
		expect(data.unavailable).toEqual([]);
		expect(data.contacted).toEqual([
			{ memberId: club.adminMemberId, meetingId: club.meetingId },
		]);
	});
```

`public-reads.integration.test.ts` (or whichever suite covers `getMeeting`'s loader):

```ts
	it("excludes a coming member from unavailableMembers", async () => {
		await testDb.insert(meetingAttendancePlan).values([
			{ memberId: club.memberId, meetingId: club.meetingId, status: "coming" },
			{ memberId: club.adminMemberId, meetingId: club.meetingId, status: "reached_out" },
		]);
		const data = await loadMeetingData({ meetingId: club.meetingId, canManage: true });
		expect(data.unavailableMembers).toEqual([]);
		expect(data.contactedMemberIds).toEqual([club.adminMemberId]);
	});
```

`recurrence-rule.integration.test.ts` — a meeting whose only plan row is `coming` is still **untouched**, so it stays materializable:

```ts
	it("does not count a coming answer as a touched meeting", async () => {
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "coming",
		});
		const materializable = await listMaterializableMeetings(testDb, [club.meetingId]);
		expect(materializable.map((m) => m.id)).toContain(club.meetingId);
	});
```

`membership-collapse-logic.integration.test.ts` — the merge re-points plan rows and drops the absorbed duplicate:

```ts
	it("re-points plan rows and drops the absorbed duplicate", async () => {
		await testDb.insert(meetingAttendancePlan).values([
			{ memberId: keeperId, meetingId: club.meetingId, status: "coming" },
			{ memberId: absorbedId, meetingId: club.meetingId, status: "not_coming" },
		]);
		await collapseMembership(testDb, { keeperId, absorbedId });
		const rows = await testDb
			.select({ memberId: meetingAttendancePlan.memberId, status: meetingAttendancePlan.status })
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.meetingId, club.meetingId));
		expect(rows).toEqual([{ memberId: keeperId, status: "coming" }]);
	});
```

Loader and helper names above (`loadSeasonGridData`, `loadMeetingData`, `listMaterializableMeetings`, `collapseMembership`) are the exported functions those suites already call — confirm each against the suite's existing imports before writing, and use whatever name is actually exported.

- [ ] **Step 2: Run them to verify they fail**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/season-grid.integration.test.ts \
    src/server/recurrence-rule.integration.test.ts \
    src/server/membership-collapse-logic.integration.test.ts \
    src/server/public-reads.integration.test.ts
```

Expected: FAIL — the readers still query the dropped-in-Task-7 tables, or (once repointed) count every plan row as unavailable.

- [ ] **Step 3: Repoint `src/server/meetings.ts`**

Replace the `unavailableMembers` query (around line 257) with `listNotComingWithNames(db, meetingId)` and the `contactedRows`/`contactedMemberIds` block (around line 266) with:

```ts
	// Admin-only, same gate as the roster: never leaks who was asked.
	const contactedMemberIds = canManage
		? await listReachedOutForMeeting(db, meetingId)
		: [];
```

Drop the `memberAvailability` and `meetingOutreach` imports.

- [ ] **Step 4: Repoint `src/server/season-grid-logic.ts`**

The two separate queries (around lines 282 and 292) collapse into one seam call plus a partition. Keep the exported `unavailable` and `contacted` shapes — `src/lib/season-grid-view.ts` and its tests consume them unchanged:

```ts
	const planRows = await listPlanForMeetings(db, meetingIds);
	const unavailable = planRows
		.filter((r) => r.status === "not_coming")
		.map(({ memberId, meetingId }) => ({ memberId, meetingId }));
	const contacted = input.includeOutreach
		? planRows
				.filter((r) => r.status === "reached_out")
				.map(({ memberId, meetingId }) => ({ memberId, meetingId }))
		: [];
```

- [ ] **Step 5: Repoint `src/server/recurrence-rule-logic.ts`**

Replace the `avail` query (around line 111) with `listNotComingForMeetings(db, meetingIds)` and build `availSet` from its `meetingId`s. A `coming` or `reached_out` row must **not** mark a meeting as touched — nobody has edited the agenda by answering a question.

- [ ] **Step 6: Repoint `src/server/membership-collapse-logic.ts`**

Replace step 3 of the merge (around line 136) — the `member_availability` de-dup and re-point — with the same two statements against `meeting_attendance_plan`:

```ts
	// 3. meeting_attendance_plan.member_id — unique (member, meeting). Drop the
	//    absorbed dup for a meeting the keeper already covers, then re-point.
	await tx.execute(sql`
		DELETE FROM meeting_attendance_plan
		WHERE member_id = ${absorbedId}
			AND meeting_id IN (
				SELECT meeting_id FROM meeting_attendance_plan WHERE member_id = ${keeperId}
			)`);
	await tx
		.update(meetingAttendancePlan)
		.set({ memberId: keeperId })
		.where(eq(meetingAttendancePlan.memberId, absorbedId));
```

There is no separate `meeting_outreach` step to keep — one table, one step.

**This suite is already RED and this step is what fixes it.** `membership-collapse-logic.integration.test.ts` (~line 591) carries an FK drift-guard: a hand-maintained `HANDLED` set of every `(table, column)` FK pointing at `members.id` that `collapseMemberships` re-points, asserted for exact equality against the live catalog, so a new FK "fails LOUDLY here — instead of silently cascade-deleting or orphaning that data on the next merge." Task 1 added `meeting_attendance_plan.member_id` and the guard has been failing ever since — correctly. Update the set: add `"meeting_attendance_plan.member_id"`, and remove `"member_availability.member_id"` and `"meeting_outreach.member_id"` **in Task 7**, when those tables are actually dropped, not here. The guard compares against the live database, so removing them early turns one red test into a differently-red test.

- [ ] **Step 7: Run the suites to verify they pass**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/season-grid.integration.test.ts \
    src/server/recurrence-rule.integration.test.ts \
    src/server/membership-collapse-logic.integration.test.ts \
    src/server/public-reads.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/
git commit -m "feat(server): read planned attendance in every availability consumer"
```

---

## Task 7: Drop the old tables and lock the seam

**Files:**
- Modify: `src/db/schema.ts` (already done in Task 1 — verify), `drizzle/`
- Create: `src/server/attendance-plan-store.guard.test.ts`

- [ ] **Step 1: Write the failing guard test**

Create `src/server/attendance-plan-store.guard.test.ts`:

```ts
/**
 * Two directional guards, both read RAW (not comment-blind): each asserts a set
 * of offenders is EMPTY, so a comment merely naming a dropped table would make
 * them falsely FAIL, never falsely pass. That is the safe direction — see
 * `src/test/guard-source.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SEAM = "src/server/attendance-plan-logic.ts";
const DROPPED = ["member_availability", "meetingAvailability", "meeting_outreach", "meetingOutreach"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sourceFiles(path, acc);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(path);
	}
	return acc;
}

describe("planned-attendance store", () => {
	it("names no dropped table anywhere in src/", () => {
		const offenders = sourceFiles("src").filter((f) => {
			if (f.endsWith("attendance-plan-backfill.ts")) return false; // the backfill SQL
			const src = readFileSync(f, "utf8");
			return DROPPED.some((t) => src.includes(t));
		});
		expect(offenders).toEqual([]);
	});

	it("is reached only through the seam", () => {
		const offenders = sourceFiles("src").filter((f) => {
			if (f === SEAM || f.endsWith("schema.ts")) return false;
			// The membership merge de-dups with raw SQL before re-pointing; that
			// two-statement dance has no seam function and does not want one.
			if (f.endsWith("membership-collapse-logic.ts")) return false;
			return readFileSync(f, "utf8").includes("meetingAttendancePlan");
		});
		expect(offenders).toEqual([]);
	});
});
```

Every other consumer must go through a seam function — `listPlanForMeetings`, `listNotComingWithNames`, `listNotComingForMeetings`, `listReachedOutForMeeting`, `setPlanStatus`, `clearPlanStatus`. If this assertion names a file you wrote in Task 6, move its query into the seam rather than widening the waiver list.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bunx vitest run src/server/attendance-plan-store.guard.test.ts
```

Expected: FAIL — offenders listed.

- [ ] **Step 3: Fix every offender, then remove the tables from the schema**

Fix each file the guard named. Then delete `src/server/attendance-plan-backfill.integration.test.ts` and `src/server/attendance-plan-backfill.ts` — they exercise the legacy tables and cannot survive them; the backfill migration is the permanent artifact and it has already run. Only once the guard passes its first assertion, delete the `memberAvailability` and `meetingOutreach` blocks from `src/db/schema.ts` (left in place since Task 1 so every intermediate commit typechecks), along with any now-unused imports. Then:

```bash
bun run typecheck && bun run db:generate
```

`typecheck` must pass **before** you generate: a lingering import of a deleted table is exactly what this step exists to surface.

Expected: a new migration containing only `DROP TABLE "meeting_outreach";` and `DROP TABLE "member_availability";`.

- [ ] **Step 4: Apply and re-verify no drift**

```bash
bun run db:migrate
DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run db:push --force
bun run db:generate
```

Expected: the final `db:generate` produces **no** new file. CI fails the build if `schema.ts` drifts from the committed migrations.

- [ ] **Step 5: Run the guard test to verify it passes**

```bash
bunx vitest run src/server/attendance-plan-store.guard.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/ src/server/attendance-plan-store.guard.test.ts
git commit -m "feat(db): drop member_availability and meeting_outreach"
```

---

## Task 8: Full verification

- [ ] **Step 1: Typecheck**

```bash
bun run typecheck
```

Expected: no errors. This is the **only** thing that type-checks — `bun run build` and `bun run test` both transpile without checking and pass on type-broken code.

- [ ] **Step 2: Full test suite with the database**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run test
```

Expected: PASS. Confirm the total test count is in the ~3,500 range, not ~2,900 — a low count means `TEST_DATABASE_URL` was not picked up and the integration suites skipped while still reading green.

- [ ] **Step 3: Prove the sweep test can actually fail**

Coverage numbers do not show whether Task 6's fixture rows are load-bearing. Temporarily revert one reader's `status = 'not_coming'` filter — `season-grid-logic.ts` is the easiest — and re-run that suite:

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/season-grid.integration.test.ts
```

Expected: FAIL. If it passes, the fixture is not exercising the filter and the test is decorative. Restore the filter before continuing.

- [ ] **Step 4: Lint gate, with CI's invocation**

```bash
bunx biome check --diagnostic-level=error
```

Expected: no errors. `src/db/seed.ts` carries ~118 pre-existing warnings; the `--diagnostic-level=error` flag is what makes a real error visible in the tail. Use `bun run fix` to apply the auto-fixable part — never `--unsafe`, which on this repo rewrites `!` into `?.` and lets `undefined` flow into DB writes.

- [ ] **Step 5: Check the route tree was not left dirty**

```bash
git status --short src/routeTree.gen.ts
```

`bun run build` and `bun run dev` both append an SSR Register block to this generated file. If it shows as modified, `git checkout src/routeTree.gen.ts` before committing.

- [ ] **Step 6: Commit any fixes and push**

```bash
git add -A
git commit -m "chore: verification fixes for planned-attendance data model"
git push -u origin feat/planned-attendance
```

---

## Definition of done

- `meeting_attendance_plan` is the only store; `member_availability` and `meeting_outreach` are dropped and unreferenced.
- Prod data is preserved: availability → `not_coming`, outreach-only → `reached_out`.
- All seven consumers filter on `status = 'not_coming'`, each proven by a fixture containing a `coming` row.
- No client file changed — the Outreach checkbox and the availability button behave exactly as before.
- `bun run typecheck`, the full DB-backed suite, and `biome check --diagnostic-level=error` are all clean.

## Not in this PR

The panel, the rail layout, the WhatsApp contact drafts, the personal strip's "I'll be there" (PR 2); roll mode, guests and the shared offline queue (PR 3). `setPlannedAttendance` / `clearPlannedAttendance` ship here unused by the UI — PR 2 wires them up and deletes the five legacy delegates.
