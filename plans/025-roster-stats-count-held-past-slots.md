# Plan 025: "Speeches given" and "Roles served this year" count only held slots on past, uncancelled meetings, in the club's year

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b955f240..HEAD -- src/server/club.ts src/server/reporting-logic.ts src/routes/_authed/roster.tsx src/routes/_authed/members.$id.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — two read-only aggregates on two authed pages; no write path
- **Depends on**: plans/021-test-db-absence-fails-closed.md (the new test is DB-backed)
- **Category**: bug
- **Planned at**: commit `b955f240`, 2026-10-30

## Why this matters

Two numbers members see on the roster and on a member's profile are wrong in
the same direction.

- The roster's **"Speeches given"** (per row, and the stat card summing them)
  counts every speaker-role slot assigned to the member: a speech signed up
  for next month counts as given; a speech on a cancelled meeting counts; an
  `open` slot with an assignee set counts. A new member who has claimed three
  upcoming speaker slots shows "3 given".
- The profile's **"Roles served this year"** counts every slot from
  `scheduledAt >= Jan 1` with no upper bound, no cancelled filter and no slot
  status filter — and "Jan 1" is the SERVER's local calendar year
  (`new Date(new Date().getFullYear(), 0, 1)`), which on Railway is UTC. A
  Dec 31 evening meeting in the Americas lands in the next year.

The VP Education dashboard already defines "times spoken" and "last role"
correctly in `src/server/reporting-logic.ts` (past, not cancelled, held
status), so three readers of "a speech given" now disagree. After this plan,
the roster and the profile use the reporting module's definition, and the
year boundary is the club's own.

## Current state

### Files

- `src/server/club.ts` — server fns `listClubMembers` (speech count inline at
  :51-66) and `getMemberProfile` (calls the module-private `loadRolesServed`,
  :97-117).
- `src/server/reporting-logic.ts` — VPE reporting queries; owns
  `HELD_SLOT_STATUSES` (:76) and the correct predicate (`loadSpeakerRotation`,
  :443-471).
- `src/routes/_authed/roster.tsx` — renders `speeches` (:344, :388-389 stat
  card "Speeches given", :625 "N given").
- `src/routes/_authed/members.$id.tsx` — renders `rolesServed` (:469 "Roles
  served this year", empty copy "No roles served yet this year.").
- `src/lib/datetime.ts` — `zonedWallTimeToUtc(wall, timeZone)` and
  `utcToZonedWallTime(instant, timeZone)` (DST-correct helpers).
- `src/db/schema.ts:398` — `clubs.timezone` (text, default `America/Chicago`).

### Excerpts (as of `b955f240`)

`src/server/club.ts:1-5,22` (imports the change removes or keeps):

```ts
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
...
const uuid = z.string().uuid();
```

`src/server/club.ts:50-70` (inside `listClubMembers`'s handler):

```ts
		const speechRows = await db
			.select({
				memberId: roleSlots.assignedMemberId,
				speeches: sql<number>`count(*)::int`,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(meetings.clubId, clubId),
					eq(roleDefinitions.isSpeakerRole, true),
				),
			)
			.groupBy(roleSlots.assignedMemberId);

		const speechByMember = new Map(
			speechRows
				.filter((r) => r.memberId)
				.map((r) => [r.memberId as string, r.speeches]),
		);
```

`src/server/club.ts:96-117`:

```ts
/** Roles a member has served (any role), grouped by role name, for the current calendar year. */
async function loadRolesServed(memberId: string, clubId: string) {
	const yearStart = new Date(new Date().getFullYear(), 0, 1);
	return db
		.select({
			name: roleDefinitions.name,
			count: sql<number>`count(*)::int`,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, yearStart),
			),
		)
		.groupBy(roleDefinitions.name)
		.orderBy(desc(sql`count(*)`));
}
```

and its call at `:171`: `const rolesServed = await loadRolesServed(member.id, data.clubId);`.
`db` stays imported: `:177` and `:181` pass it to `listUnscheduledSpeeches` /
`listOpenSpeakerSlots`.

`src/server/reporting-logic.ts:75-76` and `:443-471` (the correct definition):

```ts
/** A slot only counts as "held" once it's claimed or confirmed. */
export const HELD_SLOT_STATUSES = ["claimed", "confirmed"] as const;
```

```ts
export async function loadSpeakerRotation(clubId: string): Promise<SpeakerRotationRow[]> {
	const now = new Date();
	const speakerStats = db
		.select({
			memberId: roleSlots.assignedMemberId,
			timesSpoken: sql<number>`count(${roleSlots.id})::int`.as("times_spoken"),
			lastSpokenAt: max(meetings.scheduledAt).as("last_spoken_at"),
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			and(
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				eq(roleDefinitions.isSpeakerRole, true),
			),
		)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.where(inArray(roleSlots.status, [...HELD_SLOT_STATUSES]))
		.groupBy(roleSlots.assignedMemberId)
		.as("speaker_stats");
```

`reporting-logic.ts` already imports `clubs`, `meetings`, `members`,
`roleDefinitions`, `roleSlots` from `#/db/schema`, `and, eq, gte, inArray, lt,
ne, sql, desc` from `drizzle-orm`, and `DEFAULT_CLUB_TIMEZONE` from
`#/lib/club-timezone`. It does NOT yet import `#/lib/datetime`.

`src/lib/datetime.ts:35,54`:

```ts
export function zonedWallTimeToUtc(wall: string, timeZone: string): Date
export function utcToZonedWallTime(instant: Date, timeZone: string): string  // "YYYY-MM-DDTHH:mm"
```

Test fixtures: `src/test/db.ts` exports `seedClub()` → `SeededClub`
(`clubId, adminUserId, memberUserId, personId, memberId, adminMemberId,
roleDefinitionId, meetingId, slotId`), `seedPerson`, `cleanup(clubId, userIds)`,
`testDb`, `hasTestDb`. `src/server/reporting.integration.test.ts:45-125` has
local helpers `addMember`, `addMeeting(clubId, daysAgo)`,
`addUpcomingMeeting(clubId, daysAhead, status)`, `addSlot({meetingId,
roleDefinitionId, memberId, status})`, and seeds a speaker role at `:134-144`
by inserting into `roleDefinitions` with `isSpeakerRole: true`. Copy those
helpers (they are not exported).

### Conventions to match

- `club.ts` is a server-fn module: it may export only `createServerFn`s and
  types (`server-modules.guard.test.ts`), which is why the queries move to a
  `*-logic.ts` module. `club-contact-gate.guard.test.ts` enumerates every
  `createServerFn` in `club.ts` and holds those calling `loadClubMembers` /
  `loadMemberProfile` to `requireClubViewAccess` — unchanged by this plan.
- Inject `now` with a default (`now: Date = new Date()`) as
  `ensureScheduleToppedUp` does, so the test never depends on the real clock
  (CODING_STANDARDS.md "real-clock date boundaries").
- Integration tests: per-run keys, `cleanup(clubId, userIds)` in `afterEach`,
  every assertion scoped to the seeded club (`docs/agents/commands.md`).
- Biome: tabs, double quotes. Conventional commits: `fix(roster): …`.
- `CONTEXT.md` vocabulary: a slot is "held" when `claimed` or `confirmed`; a
  cancelled meeting "keeps its date reserved" but is not a meeting that
  happened.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Bootstrap worktree | `bun run worktree:setup "plan 025"` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 (it is what catches now-unused imports) |
| Lint gate | `bunx biome check --diagnostic-level=error` | exit 0 |
| New suite | `bunx vitest run src/server/club-stats.integration.test.ts` | all pass (needs the worktree's test DB) |
| Guards | `bunx vitest run src/server/club-contact-gate.guard.test.ts src/server/server-modules.guard.test.ts src/server/reporting.integration.test.ts` | all pass |
| Mutation | `bun run mutate src/server/reporting-logic.ts --literal <old> <new> <label> src/server/club-stats.integration.test.ts` | red, restored |
| Full suite | `bun run test` | exit 0 |

## Files

- `src/server/reporting-logic.ts`
- `src/server/club.ts`
- `src/server/club-stats.integration.test.ts`

## Scope

**In scope** (the only files you should modify): the three files above (the
test is new).

**Out of scope** (do NOT touch, even though they look related):

- `src/routes/_authed/roster.tsx` and `src/routes/_authed/members.$id.tsx` —
  the payload shape (`speeches: number`, `rolesServed: {name, count}[]`) is
  unchanged; the copy is already right.
- `src/server/milestones-logic.ts:25-41` — its "first speech" count also
  requires `speechId is not null` and uses the meeting END; that is a
  milestone's definition, not the roster's. Leave it.
- `loadSpeakerRotation` / `loadOverdueMembers` in `reporting-logic.ts` — do
  not refactor their predicates into a shared helper; add the two new
  functions beside them with the same shape.
- The profile's `speeches: speechLog.length` (`club.ts:210`) — a different
  count (the speech log), not this bug.
- Switching "this year" to the Toastmasters program year (July–June): a
  product change; the label says "this year" and stays calendar-year.

## Git workflow

- Branch: `roster-stats-held-past-025`, as a worktree, bootstrapped.
- Commit per step; conventional-commit messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the two aggregates to `reporting-logic.ts`

Add `import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";`
and, after `loadSpeakerRotation`, the two functions:

```ts
/**
 * "Speeches given" for every member of a club (the roster's per-row count and
 * stat card): held speaker slots (`HELD_SLOT_STATUSES`) on meetings that have
 * already happened and were not cancelled. The same definition as
 * `loadSpeakerRotation`'s "times spoken" — a signed-up future speech, a speech
 * on a cancelled meeting and an `open` slot with a stale assignee all used to
 * count (club.ts, before this). `now` is injectable for tests.
 */
export async function loadSpeechesGivenByMember(
	clubId: string,
	now: Date = new Date(),
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			memberId: roleSlots.assignedMemberId,
			speeches: sql<number>`count(${roleSlots.id})::int`,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			and(
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				eq(roleDefinitions.isSpeakerRole, true),
			),
		)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				eq(meetings.clubId, clubId),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.where(inArray(roleSlots.status, [...HELD_SLOT_STATUSES]))
		.groupBy(roleSlots.assignedMemberId);
	return new Map(
		rows
			.filter((r) => r.memberId)
			.map((r) => [r.memberId as string, r.speeches]),
	);
}

/**
 * "Roles served this year" for one member (the profile's chips): held slots
 * of any role on meetings in the club's CURRENT CALENDAR YEAR that have
 * already happened and were not cancelled, grouped by role name, busiest
 * first. "This year" is the club's year: Jan 1 00:00 in `clubs.timezone`
 * (`zonedWallTimeToUtc`), not the server's UTC midnight — a Dec 31 evening
 * meeting in the Americas is still last year. `now` is injectable for tests.
 */
export async function loadRolesServedThisYear(
	memberId: string,
	clubId: string,
	now: Date = new Date(),
): Promise<{ name: string; count: number }[]> {
	const club = await db.query.clubs.findFirst({
		columns: { timezone: true },
		where: eq(clubs.id, clubId),
	});
	const tz = club?.timezone ?? DEFAULT_CLUB_TIMEZONE;
	const year = utcToZonedWallTime(now, tz).slice(0, 4);
	const yearStart = zonedWallTimeToUtc(`${year}-01-01T00:00`, tz);
	return db
		.select({
			name: roleDefinitions.name,
			count: sql<number>`count(${roleSlots.id})::int`,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, yearStart),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				inArray(roleSlots.status, [...HELD_SLOT_STATUSES]),
			),
		)
		.groupBy(roleDefinitions.name)
		.orderBy(desc(sql`count(${roleSlots.id})`), roleDefinitions.name);
}
```

(The `orderBy` tie-break on `name` is deliberate: tied counts must not
reorder between loads — the repo's #1372 lesson.)

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Wire `club.ts` to them and delete the inline copies

In `src/server/club.ts`:

1. Replace the `speechRows` query and the `speechByMember` map construction
   (quoted in "Current state") with:
   ```ts
   		const speechByMember = await loadSpeechesGivenByMember(clubId);
   ```
   The later `speeches: speechByMember.get(m.id) ?? 0,` line is unchanged.
2. Delete the module-private `loadRolesServed` function and its doc comment.
3. Change `:171` to
   `const rolesServed = await loadRolesServedThisYear(member.id, data.clubId);`.
4. Add `import { loadRolesServedThisYear, loadSpeechesGivenByMember } from "./reporting-logic";`
   and remove the now-unused imports: `and, desc, eq, gte, sql` from
   `drizzle-orm` and `meetings, roleDefinitions, roleSlots` from
   `#/db/schema`. Keep `db` (still passed to two speech helpers), `z`,
   `createServerFn`.

**Verify**:

- `bun run typecheck` → exit 0 (an unused import would fail here under
  `noUnusedLocals`).
- `bunx biome check --diagnostic-level=error` → exit 0.
- `grep -n "roleSlots\|roleDefinitions\|getFullYear" src/server/club.ts` → no output.
- `bunx vitest run src/server/club-contact-gate.guard.test.ts src/server/server-modules.guard.test.ts` → all pass.

### Step 3: The integration test

Create `src/server/club-stats.integration.test.ts`. Model its header, the
`vi.mock("#/db", …)` line, `describe.skipIf(!hasTestDb)`, `beforeEach(seedClub)`
and `afterEach(cleanup)` on `src/server/club-contact.integration.test.ts`,
and copy the `addMember`, `addMeeting`, `addUpcomingMeeting`, `addSlot`
helpers and the speaker-role insert from `src/server/reporting.integration.test.ts`
(lines 45-125 and 134-144). Then:

```ts
describe.skipIf(!hasTestDb)("roster stats count held slots on past, uncancelled meetings", () => {
	// seed, speakerRoleId, a non-speaker role (seed.roleDefinitionId), the member

	it("Speeches given: a past held speaker slot counts; future, cancelled and open ones do not", async () => {
		const { loadSpeechesGivenByMember } = await import("#/server/reporting-logic");
		const past = await addMeeting(seed.clubId, 7);
		const future = (await addUpcomingMeeting(seed.clubId, 7)).meetingId;
		const cancelled = (await addUpcomingMeeting(seed.clubId, -14, "cancelled")).meetingId; // 14 days AGO, cancelled
		await addSlot({ meetingId: past, roleDefinitionId: speakerRoleId, memberId: seed.memberId, status: "confirmed" });
		await addSlot({ meetingId: future, roleDefinitionId: speakerRoleId, memberId: seed.memberId, status: "claimed" });
		await addSlot({ meetingId: cancelled, roleDefinitionId: speakerRoleId, memberId: seed.memberId, status: "confirmed" });
		await addSlot({ meetingId: past, roleDefinitionId: speakerRoleId, memberId: seed.memberId, status: "open" });
		// a non-speaker role on the past meeting must not count either
		await addSlot({ meetingId: past, roleDefinitionId: seed.roleDefinitionId, memberId: seed.memberId, status: "confirmed" });

		const counts = await loadSpeechesGivenByMember(seed.clubId);
		expect(counts.get(seed.memberId)).toBe(1);
		expect(counts.get(seed.adminMemberId)).toBeUndefined();
	});

	it("Roles served this year: bounded to [club-local Jan 1, now), held, uncancelled", async () => {
		const { loadRolesServedThisYear } = await import("#/server/reporting-logic");
		// Club in Los Angeles. "now" is 2026-03-01T12:00Z.
		await testDb.update(clubs).set({ timezone: "America/Los_Angeles" }).where(eq(clubs.id, seed.clubId));
		const now = new Date("2026-03-01T12:00:00Z");
		const at = async (iso: string, status: "scheduled" | "cancelled" = "scheduled") => { /* insert a meeting at new Date(iso) with status, return id */ };
		const lastYearUtcButNotLocal = await at("2026-01-01T03:00:00Z"); // Dec 31 19:00 in LA → last year
		const thisYear = await at("2026-01-01T09:00:00Z");               // Jan 1 01:00 in LA → this year
		const alsoThisYear = await at("2026-02-10T04:00:00Z");
		const future = await at("2026-04-01T04:00:00Z");
		const cancelled = await at("2026-02-01T04:00:00Z", "cancelled");
		for (const m of [lastYearUtcButNotLocal, thisYear, alsoThisYear, future, cancelled]) {
			await addSlot({ meetingId: m, roleDefinitionId: seed.roleDefinitionId, memberId: seed.memberId, status: "confirmed" });
		}
		await addSlot({ meetingId: thisYear, roleDefinitionId: seed.roleDefinitionId, memberId: seed.memberId, status: "open" });

		const rows = await loadRolesServedThisYear(seed.memberId, seed.clubId, now);
		expect(rows).toEqual([{ name: expect.any(String), count: 2 }]);
	});

	it("Roles served: the server's year is not the club's", async () => {
		// Same data, club in Pacific/Auckland: 2026-01-01T03:00Z is Jan 1 16:00 NZDT → THIS year.
		// (set timezone, insert the 03:00Z meeting with a held slot, assert count 1 with now = 2026-03-01T12:00Z)
	});
});
```

Write the two sketched helpers/cases out in full (the `at` helper inserts a
`meetings` row at the given instant; the Auckland case mirrors the LA one with
the opposite expectation). Use `seed.roleDefinitionId` for the non-speaker
role and insert a speaker role as the reporting suite does.

**Verify**: `bunx vitest run src/server/club-stats.integration.test.ts` →
3 passed.

**Mutate** (each must go red):

```bash
bun run mutate src/server/reporting-logic.ts --literal "				lt(meetings.scheduledAt, now),
				ne(meetings.status, \"cancelled\"),
			),
		)
		.where(inArray(roleSlots.status, [...HELD_SLOT_STATUSES]))
		.groupBy(roleSlots.assignedMemberId);
	return new Map(" "			),
		)
		.groupBy(roleSlots.assignedMemberId);
	return new Map(" speeches-unfiltered src/server/club-stats.integration.test.ts
```

If the multi-line literal is awkward, mutate ONE condition at a time inside
`loadSpeechesGivenByMember` (`lt(meetings.scheduledAt, now)` → `sql\`true\``,
then `ne(meetings.status, "cancelled")` → `sql\`true\``) and confirm the first
test fails each time. For `loadRolesServedThisYear`, mutate
`` zonedWallTimeToUtc(`${year}-01-01T00:00`, tz) `` → `` new Date(`${year}-01-01T00:00:00Z`) ``
and confirm the Auckland or LA case fails (one of them must).

### Step 4: Gate

```bash
bun run typecheck && bunx biome check --diagnostic-level=error && bunx vitest run src/server/reporting.integration.test.ts src/server/club-stats.integration.test.ts src/server/club-contact.integration.test.ts && bun run test
```

→ all exit 0.

## Test plan

- New `src/server/club-stats.integration.test.ts`: three cases (speeches:
  past-held counts, future/cancelled/open/non-speaker do not; roles: club-local
  year lower bound, `now` upper bound, cancelled and open excluded; the
  timezone case with the opposite outcome). Patterns:
  `club-contact.integration.test.ts` (structure),
  `reporting.integration.test.ts` (seeding helpers).
- Mutations as in Step 3, outputs in the PR body.
- Existing: `reporting.integration.test.ts` (its definitions are untouched),
  the two `club.ts` guards.

## Done criteria

- [ ] `bun run typecheck` and `bunx biome check --diagnostic-level=error` exit 0
- [ ] `grep -n "roleSlots\|roleDefinitions\|getFullYear" src/server/club.ts` → no output
- [ ] `grep -n "export async function loadSpeechesGivenByMember\|export async function loadRolesServedThisYear" src/server/reporting-logic.ts` → two matches
- [ ] `bunx vitest run src/server/club-stats.integration.test.ts` → 3 passed; the mutations in Step 3 went red
- [ ] `bun run test` exits 0
- [ ] `git status --porcelain` shows only the three in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts of `club.ts` do not match.
- `server-modules.guard.test.ts` or `club-contact-gate.guard.test.ts` fails
  after Step 2 (you exported something from `club.ts` or changed a handler's
  gate order).
- `db.query.clubs.findFirst` is not available on the `db` instance used in
  `reporting-logic.ts` (it is — `schedule-topup-logic.ts` uses the same
  call — but if typecheck disagrees, use a `select` instead and say so).
- The LA and Auckland cases both pass under the `new Date(…Z)` mutation: your
  fixture instants do not straddle the boundary; fix the fixture, not the
  assertion.
- The fix appears to require touching a route file.

## Maintenance notes

- Three definitions of "a speech that counts" now exist on purpose:
  reporting/roster (held, past, uncancelled), milestones (additionally
  `speechId is not null` and meeting END passed), and the speech log. A
  future "speeches" number must pick one of these explicitly.
- If the product moves "Roles served" to the Toastmasters program year
  (July 1), the change is the two lines computing `yearStart`; the test's
  instants need re-picking.
- Reviewer: check the `club.ts` diff removes the inline query entirely rather
  than leaving it dead, and that `now` is injected only in tests.
