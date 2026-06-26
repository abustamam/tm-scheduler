# Plan 003: Interpret and display meeting times in the club's timezone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/db/schema.ts src/server/meetings.ts src/lib/format.ts src/routes/_authed/meetings.\$id.tsx src/routes/_authed/index.tsx src/routes/_authed/me.tsx`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/001-extract-pure-agenda-logic.md (Vitest harness for the conversion helper)
- **Category**: bug (correctness)
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/13

## Why this matters

When an admin creates a meeting, the form sends an HTML `datetime-local` value
like `"2026-07-03T19:00"` (a wall-clock time with **no timezone**). The server
does `new Date(data.scheduledAt)` (`src/server/meetings.ts:169`), and JavaScript
interprets a timezone-less date-time string in the **server process's** local
zone. On the production target — a Hetzner VPS, typically set to UTC
(`docs/adr/0003-hetzner-node-server.md`) — "19:00" becomes 19:00 UTC. The value
is stored in a `timestamptz` column and then rendered with
`Intl.DateTimeFormat(undefined, …)` (`src/lib/format.ts:1-9`), which formats in
**each viewer's browser zone**. So an admin in US Central who types 7:00 PM
produces a meeting that members see at 1:00 PM. For an app whose entire job is
telling people when to show up, this is a correctness defect.

The fix: give each club an IANA timezone, interpret the admin's wall-clock input
in that zone when creating a meeting, and render every meeting time in that same
club zone (not the viewer's). This matches the real-world model — a club meets
at a fixed local time regardless of where a member's phone is.

## Current state

- `src/db/schema.ts:58-62` — `clubs` table has only `id`, `name`, `createdAt`.
  No timezone column.
- `src/server/meetings.ts:152-172` — `createMeetingSchema` and the handler:
  ```ts
  // HTML datetime-local value, interpreted in the server's local zone.
  scheduledAt: z.string().min(1),
  ...
  const scheduledAt = new Date(data.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) { throw new Error("Invalid meeting date/time."); }
  ```
- `src/lib/format.ts` — `formatMeetingDate` / `formatMeetingTime` /
  `formatMeetingDateTime`, all using `Intl.DateTimeFormat(undefined, …)` (no
  `timeZone`), so they render in the viewer's zone.
- Read paths that return `scheduledAt` and feed the formatters:
  `listUpcomingMeetings` (`meetings.ts:19-46`), `getMeeting` (`meetings.ts:49-114`,
  returns the `meeting` row), `listMyCommitments` (`meetings.ts:117-150`).
- UI call sites of the formatters: `src/routes/_authed/index.tsx:44-47`,
  `src/routes/_authed/meetings.$id.tsx:103-104`, `src/routes/_authed/me.tsx:72-73`.

Conventions: tabs + double quotes (Biome), `#/` alias, strict TS, Drizzle
migrations via `bun run db:generate` then `bun run db:migrate` (or `db:push` for
dev). ADR-0006 establishes that everything club-scoped carries `club_id` — a
club timezone fits that model cleanly.

## Commands you will need

| Purpose         | Command                                  | Expected on success     |
|-----------------|------------------------------------------|-------------------------|
| Typecheck       | `bunx tsc --noEmit`                       | exit 0                  |
| Gen migration   | `bun run db:generate`                     | new file in `drizzle/`  |
| Apply (dev)     | `bun run db:push`                         | "Changes applied"       |
| Unit test       | `bunx vitest run src/lib/format.test.ts`  | all pass                |
| Lint/fmt        | `bun run check`                           | exit 0                  |

## Scope

**In scope** (create/modify):
- `src/db/schema.ts` — add `timezone` to `clubs`.
- `drizzle/` — generated migration (via `db:generate`; do not hand-edit).
- `src/lib/format.ts` — make formatters accept a timezone.
- `src/lib/datetime.ts` (create) — pure wall-clock-in-zone → UTC `Date` helper.
- `src/lib/datetime.test.ts` (create) — its unit tests.
- `src/server/meetings.ts` — interpret input in the club zone; return club tz
  from read queries.
- `src/routes/_authed/index.tsx`, `meetings.$id.tsx`, `me.tsx` — pass the club tz
  to the formatters.

**Out of scope** (do NOT touch):
- `src/db/seed.ts` — it builds `Date`s directly; leave it (seed data is dev-only).
  Optionally set the seeded club's timezone, but no logic changes.
- Auth, guards, claim/release flows.
- Any per-user timezone preference — this is a per-**club** time, deliberately.

## Git workflow

- Branch: `advisor/003-meeting-timezone`
- Conventional commits, e.g. `fix: interpret and render meeting times in club timezone`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add `timezone` to `clubs` and migrate

In `src/db/schema.ts`, add to the `clubs` table:

```ts
timezone: text("timezone").notNull().default("America/Chicago"),
```

(IANA identifier. The default is a placeholder so the migration is safe on
existing rows; the real value is set per club at creation — but a club-creation
UI is out of scope, so document that admins set it via seed/db for now.)

**Verify**: `bun run db:generate` → a new migration appears under `drizzle/`;
`bunx tsc --noEmit` → exit 0. Apply with `bun run db:push` against your dev DB.

### Step 2: Pure wall-clock-in-zone → UTC helper, with tests

Create `src/lib/datetime.ts`. Implement `zonedWallTimeToUtc(wall: string, timeZone: string): Date`
that takes a `datetime-local` string (`"YYYY-MM-DDTHH:mm"`) meant as wall-clock
time **in `timeZone`** and returns the correct UTC `Date`. Use the standard
`Intl` offset technique (no new dependency):

```ts
/** Convert a timezone-less wall-clock string to the UTC instant it denotes in `timeZone`. */
export function zonedWallTimeToUtc(wall: string, timeZone: string): Date {
	// Parse the wall components.
	const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
	if (!m) throw new Error("Invalid date/time.");
	const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
	// Treat the components as if they were UTC, then correct by the zone's offset.
	const asUtc = Date.UTC(y, mo - 1, d, h, mi);
	const offset = zoneOffsetMs(asUtc, timeZone);
	return new Date(asUtc - offset);
}

/** Offset (ms) of `timeZone` at the given instant: localWall - utc. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone, hour12: false,
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit",
	});
	const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
	const asUtc = Date.UTC(
		Number(parts.year), Number(parts.month) - 1, Number(parts.day),
		Number(parts.hour === "24" ? "0" : parts.hour), Number(parts.minute), Number(parts.second),
	);
	return asUtc - utcMs;
}
```

Create `src/lib/datetime.test.ts` covering:
- `"2026-07-03T19:00"` in `"America/Chicago"` (CDT, UTC−5) → ISO
  `2026-07-04T00:00:00.000Z` (`.toISOString()` equals that).
- A winter date `"2026-01-10T19:00"` in `"America/Chicago"` (CST, UTC−6) →
  `2026-01-11T01:00:00.000Z` (proves DST is handled, not a fixed offset).
- `"2026-07-03T19:00"` in `"UTC"` → `2026-07-03T19:00:00.000Z` (identity).
- A malformed string throws.

**Verify**: `bunx vitest run src/lib/datetime.test.ts` → all pass.

### Step 3: Use the helper on meeting creation

In `src/server/meetings.ts` `createMeeting` handler: the club's timezone is
needed. Fetch it alongside the role definitions (or in the same transaction):

```ts
const club = await db.query.clubs.findFirst({ where: eq(clubs.id, data.clubId) });
if (!club) throw new Error("Club not found.");
const scheduledAt = zonedWallTimeToUtc(data.scheduledAt, club.timezone);
```

Remove the old `new Date(data.scheduledAt)` + `Number.isNaN` block (the helper
throws on malformed input). Import `zonedWallTimeToUtc` from `#/lib/datetime` and
`clubs` from `#/db/schema` (already imported). Update the comment on
`createMeetingSchema.scheduledAt` to say "interpreted in the club's timezone".

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 4: Return club timezone from read queries and render in it

Add `timezone: clubs.timezone` (join `clubs` where needed) to the selected
columns of the three read queries so the UI has it:
- `listUpcomingMeetings` — already filters by `meetings.clubId`; join `clubs` and
  select `clubs.timezone` (it's constant per query, include it on each row or
  return it once — simplest: include `timezone` per row).
- `getMeeting` — the `meeting` already has `clubId`; fetch the club's `timezone`
  and include it in the returned object (e.g. `return { meeting, slots, canManage, timezone: club.timezone }`).
- `listMyCommitments` — already joins `clubs`; add `timezone: clubs.timezone`.

Then make `src/lib/format.ts` accept an optional `timeZone`:

```ts
export function formatMeetingDate(value: Date | string, timeZone?: string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone }).format(d);
}
```

Do the same for `formatMeetingTime` (add `timeZone` to its options) and
`formatMeetingDateTime` (thread the param through). Construct the formatter
inside the function (a module-level cached formatter can't vary by zone).

Update the three call sites to pass the club timezone:
- `index.tsx:44-47` → `formatMeetingDate(m.scheduledAt, m.timezone)` /
  `formatMeetingTime(m.scheduledAt, m.timezone)`.
- `meetings.$id.tsx:103-104` → pass the timezone from the loader data
  (`useLoaderData` now includes `timezone`).
- `me.tsx:72-73` → `formatMeetingDate(c.scheduledAt, c.timezone)` etc.

Optionally append the zone abbreviation so members in other zones aren't
confused; not required for correctness.

**Verify**: `bunx tsc --noEmit` → exit 0; `bun run check` → exit 0.

## Test plan

- `src/lib/datetime.test.ts` — the four cases in Step 2 (DST-aware).
- Manual check (document the result, do not commit a DB): create a meeting at
  "7:00 PM" for a club whose `timezone` is `America/Chicago`; confirm the stored
  `scheduled_at` is the correct UTC instant and the detail page renders "7:00 PM"
  regardless of the browser's zone (test by changing the OS/browser zone or by
  asserting the formatter output with an explicit `timeZone`).
- Verification: `bunx vitest run` → all pass including the new datetime suite.

## Done criteria

ALL must hold:

- [ ] `clubs.timezone` exists in `src/db/schema.ts` and a migration was generated
- [ ] `bunx vitest run src/lib/datetime.test.ts` exits 0 (DST case included)
- [ ] `grep -n "new Date(data.scheduledAt)" src/server/meetings.ts` returns nothing
- [ ] All three read queries return a `timezone`, and all three UI call sites pass
      it to the formatters (`grep -n "formatMeetingDate(" src/routes` shows a
      second argument at each site)
- [ ] `bunx tsc --noEmit` exits 0; `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report (do not improvise) if:
- The "Current state" excerpts don't match the live code.
- `zonedWallTimeToUtc` fails the DST test case after one fix attempt — getting
  timezone math wrong silently is worse than not shipping; report it.
- Threading `timezone` into a read query forces a response-shape change that
  breaks an unrelated consumer you can't see — report before proceeding.

## Maintenance notes

- There is no club-creation/edit UI yet, so `timezone` is set via seed/DB for
  now. When a club admin UI is built, expose a timezone picker; the column is
  ready.
- `src/db/seed.ts` builds `Date`s with `setHours` in the seed process's local
  zone — fine for dev fixtures, but if seed data ever needs to match a specific
  club zone, route it through `zonedWallTimeToUtc` too.
- Reviewer should scrutinize the `zonedWallTimeToUtc` DST handling and confirm
  the formatters now pass `timeZone` (a missing arg silently reverts to viewer
  zone — the original bug).
- Follow-up deferred: showing the zone abbreviation in the UI and a per-user
  "show in my time" toggle.
