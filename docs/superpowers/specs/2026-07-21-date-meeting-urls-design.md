# Date-based meeting URLs

**Status:** Design approved + grilled — pending implementation plan
**Date:** 2026-07-21 (grilled 2026-07-22)
**Branch:** `feat/date-meeting-urls`

## Problem

Public meeting links carry a raw meeting UUID:

```
/club/sunrise-club/meeting/9f3c1a2b-….uuid
```

The club segment is already human-readable (`resolveClubOrRedirect` canonicalizes
any UUID / club-number / wrong-case slug to `/club/<slug>`). Only the meeting
segment is ugly. We want:

```
/club/sunrise-club/meeting/2026-07-21
```

## Goals / non-goals

**Goals**
- A meeting is reachable by its **club-local date** on the public meeting view,
  `present`, and `print`.
- Every meeting link the app *emits* — share/copy button, meeting-list links,
  prev/next nav, present/print action buttons, admin season-grid cells — uses the
  date form, so everything users newly see or paste is pretty.
- Zero broken links: existing UUID URLs keep resolving forever.

**Non-goals**
- The internal signed-in view keeps its **own address** at `/_authed/meetings/$id`
  (UUID). It is never shared; the UUID is fine there. (It still *emits* date-form
  present/print links like everywhere else — see Q1 below.)
- **No forced redirect.** Opening an old UUID link renders as-is; we do *not* 301 it
  to the date URL. The date form is an additive alias, not a replacement.
- **No durable per-meeting slug / redirect table.** Date URLs are derived from
  `scheduledAt` and are convenience links, not stable identifiers (see Q2).
- No schema change.

## Key facts (grounding)

- `meetings` has `scheduledAt timestamptz` (UTC instant) and a unique index on
  `(club_id, scheduled_at)` — unique per **instant**, not per date. A club can have
  two meetings on the same calendar day (contest + regular, makeup). Date is not a
  unique key → needs a collision rule. The same index serves the club-local-day
  range query (btree on `(club_id, scheduled_at)`).
- **`scheduledAt` is always minute-aligned.** Every creation/reschedule path
  (`meetings-logic.ts` `applyCreateMeeting`, `batch-meetings-logic.ts`,
  `meeting-recurrence.ts`) builds it via `zonedWallTimeToUtc(wall, tz)` from a
  `YYYY-MM-DDTHH:mm` string — seconds are always `:00`. So exact-instant matching on
  the `-HHmm` collision key is reliable (no sub-minute drift).
- `clubs.timezone` is an IANA zone (default `America/Chicago`). The URL date is the
  **club-local** date of `scheduledAt`, or a ~7pm meeting near midnight lands on the
  wrong calendar day.
- `src/lib/datetime.ts` already provides the tz primitives (no new dependency):
  `zonedWallTimeToUtc(wall, tz)` and `utcToZonedWallTime(instant, tz)`. Two ad-hoc
  local-date implementations already exist (`guest-pipeline-logic.ts` private
  `localDateKey`, `batch-meetings-logic.ts` inline `utcToZonedWallTime(...).slice(0,10)`).
- Public meeting data flows through `loadMeetingDetail(meetingId, userId)` in
  `src/server/meetings.ts`, which already selects `scheduledAt`, `club.timezone`, and
  `club.slug` — so computing `urlKey` there is nearly free. Its server-fn wrappers
  validate `z.string().uuid()` today.

## URL design

**Canonical (emitted) key**
- `YYYY-MM-DD` — club-local date — when it is the only meeting that local day.
- `YYYY-MM-DD-HHmm` — club-local date + 24h local time — when the club has **2+**
  meetings that local day. Every same-day meeting emits the suffixed form.

**Accepted (resolved) key** — the `$meetingId` param now accepts:
- `YYYY-MM-DD` → resolve by club-local day range; if multiple match, resolve to the
  **earliest** silently (`ORDER BY scheduled_at LIMIT 1`). No disambiguation UI.
- `YYYY-MM-DD-HHmm` → resolve by the exact club-local instant.
- a UUID → resolve by id (scoped to the club), exactly as today.
- anything else → `notFound()`.

The route param stays named `$meetingId`; only its resolution changes. The club
segment keeps its existing slug canonicalization untouched (the redirect regex
preserves the trailing meeting key, so `/club/<uuid>/meeting/2026-07-21` →
`/club/<slug>/meeting/2026-07-21`).

## Components

### 1. Pure helper — `src/lib/meeting-url.ts` (+ `meeting-url.test.ts`)

No `pg`, fully unit-tested.

- `parseMeetingKey(key): ParsedKey`
  - `{ kind: "date", date }` | `{ kind: "instant", date, hh, mm }`
    | `{ kind: "uuid", id }` | `{ kind: "invalid" }`
  - Regex: `/^(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/`; else uuid-shape check; else invalid.
- `meetingUrlKey(scheduledAt: Date, timeZone: string, collides: boolean): string`
  - `wall = utcToZonedWallTime(scheduledAt, timeZone)` → `"YYYY-MM-DDTHH:mm"`.
  - `collides ? \`${date}-${hh}${mm}\` : date`.
- `nextCalendarDate(date): string` — next `YYYY-MM-DD` via `Date.UTC(y, m-1, d+1)`
  (tz-independent; operates on the date label only).
- `localDateKey(instant, tz)` — a single canonical `utcToZonedWallTime(...).slice(0,10)`.
  Home it here (or in `datetime.ts`); the two existing ad-hoc copies MAY converge on
  it later but are **not** refactored in this change (out of scope).

### 2. DB resolution — `resolveMeetingKey` in a `*-logic.ts`

A plain, **unwrapped** logic function (no `createServerFn`) so it stays cheaply
testable and composes inside one handler (see §3). Lives in a `*-logic.ts` (touches
`#/db`) per the server-module bundle rule.

`resolveMeetingKey(clubId, key): Promise<{ meetingId, urlKey } | null>`
- Load `club.timezone`.
- `date` → `[start, end) = [zonedWallTimeToUtc(`${date}T00:00`, tz),
  zonedWallTimeToUtc(`${nextCalendarDate(date)}T00:00`, tz))`; select the club's
  meetings in `[start, end)` ordered by `scheduled_at asc`, `LIMIT 1` → earliest.
- `instant` → `at = zonedWallTimeToUtc(`${date}T${hh}:${mm}`, tz)`; select the club
  meeting with `scheduled_at = at`.
- `uuid` → select the club meeting by id.
- none → `null`.
- Compute the resolved meeting's own `urlKey`: count the club's meetings sharing its
  club-local date; `urlKey = meetingUrlKey(scheduledAt, tz, count >= 2)`. Returned for
  callers that want the canonical form of the just-resolved meeting.

Converting each midnight independently through `zonedWallTimeToUtc` keeps DST-boundary
days correct (they aren't 24h apart).

### 3. Route loaders — one combined server fn per surface (no client waterfall)

The three public routes must resolve `key → meeting` then load detail. To avoid a
two-round-trip waterfall on client-side navigation, each surface's server fn calls
`resolveMeetingKey` **and** the detail/present/print load **inside one handler**:
- `src/routes/club.$clubId.meeting.$meetingId.tsx`
- `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`
- `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

The wrapping validator loosens from `z.string().uuid()` to a non-empty string;
malformed keys surface as `notFound()` from the resolver (correct — a bad key is
not-found, not a 500). `loadMeetingDetail` itself stays UUID-based (it receives the
resolved id).

### 4. Emit `urlKey` centrally (Q1: consistent everywhere)

`loadMeetingDetail` and the meeting-**list** loaders (`club.$clubId.index`, season
grid, etc.) compute and return `urlKey` per meeting:
- Detail: reuse the resolver's `urlKey`, or compute inline (loader already has
  `scheduledAt` + `timezone`).
- Lists: group the club's fetched meetings by `localDateKey` in JS, mark any date with
  2+ as colliding, emit suffixed keys for those — no extra query.

Every link site then passes `urlKey` as the `$meetingId` param instead of the raw id:
- `src/components/club/meeting-link.tsx` (used by `season-grid.tsx` / `grid-cell.tsx`)
- `src/lib/meeting-nav.ts` (+ `meeting-nav.test.ts`) — prev/next nav
- `src/components/club/meeting-view-actions.tsx` — present/print buttons (shared by the
  public meeting view **and** the authed `/_authed/meetings/$id` view)
- `src/routes/club.$clubId.index.tsx` — meeting-list links
- `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` / `.print.tsx` — cross-links
- `src/components/share-link-button.tsx` — caller passes the app-relative path built
  from `urlKey`

Consequence (accepted): the authed view's present/print buttons emit date-form links
too. Only the authed view's *own* address stays UUID.

## Data flow

```
emit:    meeting row ──localDateKey + collides──▶ urlKey ──▶ Link params.meetingId
resolve: URL param ──parseMeetingKey──▶ {date|instant|uuid}
                   ──resolveMeetingKey(clubId,key)──▶ meetingId ──▶ loadMeetingDetail
         (both steps in ONE server-fn handler per surface)
```

## Error handling / edge cases

- **Unknown / malformed key** → `notFound()` (same page as an unknown UUID today).
- **DST spring-forward** → correct: each local midnight converts independently.
- **Old UUID link** → resolves and renders as-is; no redirect.
- **Double-header (2+ same local day)** → all emit `-HHmm`; a bare-date URL resolves to
  the earliest silently.

## Known limitations (accepted, documented)

- **Date URLs are not stable identifiers (Q2).** Rescheduling a meeting changes its
  emitted date URL; a link previously shared as the *old* date may 404 or resolve to a
  different meeting later. Mitigation: the **UUID link is permanent** and always
  resolves — it is the durable identifier for anyone who needs one. We deliberately do
  not add a stored slug / redirect table.
- **DST fall-back repeated hour (Q6).** On the ~1 night/year a wall time repeats, a
  `-HHmm` key is ambiguous and resolves to one of the two instants; a meeting in the
  other would be reachable only by UUID. Theoretical only (no club meets ~01:30 AM);
  not handled.

## Testing

- `meeting-url.test.ts` (unit): `parseMeetingKey` all kinds incl. invalid;
  `meetingUrlKey` collide/no-collide; `nextCalendarDate` month/year rollover;
  `localDateKey` across tz.
- `meetings-resolve-logic.integration.test.ts`: date resolves to the day's meeting; tz
  correctness (a meeting whose UTC date ≠ local date resolves under the *local* date);
  double-header → bare date returns earliest, `-HHmm` returns the exact one; uuid still
  resolves; unknown → null.
- `meeting-nav.test.ts`: nav `to`/params carry `urlKey`, not the raw id.
- `server-modules.guard.test.ts` already enforces the logic-file split for the new
  `*-logic.ts`.

## Rollout

Single PR, no migration, no data backfill. Additive and backward-compatible: UUID
links keep working; date links start being emitted the moment it ships.
