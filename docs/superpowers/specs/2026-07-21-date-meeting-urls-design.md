# Date-based meeting URLs

**Status:** Design approved (brainstorming) — pending implementation plan
**Date:** 2026-07-21
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
- A meeting is reachable by its **club-local date** on all public-facing surfaces:
  the public meeting view, `present`, and `print`.
- The links the app *emits* (share/copy button, meeting-list links, prev/next nav,
  present/print action buttons) use the date form, so everything users newly see or
  paste is pretty.
- Zero broken links: existing UUID URLs keep resolving forever.

**Non-goals**
- No change to the internal signed-in view `/_authed/meetings/$id` — it stays on
  the UUID (never shared; UUID is fine there).
- **No forced redirect.** Opening an old UUID link renders as-is; we do *not* 301 it
  to the date URL. The date form is an additive alias, not a replacement.
- No schema change.

## Key facts (grounding)

- `meetings` has `scheduledAt timestamptz` (UTC instant) and a unique index on
  `(club_id, scheduled_at)` — unique per **instant**, *not* per date. A club can have
  two meetings on the same calendar day (contest + regular, makeup). Date is therefore
  not a guaranteed-unique key → needs a collision rule.
- `clubs.timezone` is an IANA zone (default `America/Chicago`). The URL date must be
  the **club-local** date of `scheduledAt`, or a ~7pm meeting near midnight lands on
  the wrong calendar day.
- `src/lib/datetime.ts` already provides the needed primitives — no new dependency:
  - `zonedWallTimeToUtc(wall, timeZone)` — `"2026-07-21T00:00"` in tz → UTC `Date`.
  - `utcToZonedWallTime(instant, timeZone)` — UTC `Date` → `"YYYY-MM-DDTHH:mm"` wall
    string in tz.
- Public meeting data flows through `loadMeetingDetail(meetingId, userId)` in
  `src/server/meetings.ts`, wrapped by server fns whose validator is
  `z.string().uuid()` — so today a date key is rejected. Resolution must map
  `key → meetingId` *before* `loadMeetingDetail`, which then stays UUID-based.

## URL design

**Canonical (emitted) key**
- `YYYY-MM-DD` — club-local date — when it is the only meeting that local day.
- `YYYY-MM-DD-HHmm` — club-local date + 24h local time — when the club has **2+**
  meetings that local day. Every same-day meeting gets the suffixed form; the rare
  double-header is unambiguous and stable.

**Accepted (resolved) key** — the `$meetingId` param now accepts any of:
- `YYYY-MM-DD` → resolve by club-local day range; if multiple match, render the
  **earliest** and surface an "also this day →" affordance to the sibling(s).
- `YYYY-MM-DD-HHmm` → resolve by the exact club-local instant.
- a UUID → resolve by id (scoped to the club), exactly as today.
- anything else → `notFound()`.

The route param stays named `$meetingId`; only its resolution logic changes. The
club segment keeps its existing slug canonicalization untouched.

## Components

### 1. Pure helper — `src/lib/meeting-url.ts` (+ `meeting-url.test.ts`)

No `pg`, fully unit-tested.

- `parseMeetingKey(key: string): ParsedKey`
  - `{ kind: "date", date: "2026-07-21" }`
  - `{ kind: "instant", date: "2026-07-21", hh: "18", mm: "45" }`
  - `{ kind: "uuid", id }`
  - `{ kind: "invalid" }`
  - Regex: `/^(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/`; else uuid-shape check; else invalid.
- `meetingUrlKey(scheduledAt: Date, timeZone: string, collides: boolean): string`
  - `wall = utcToZonedWallTime(scheduledAt, timeZone)` → `"YYYY-MM-DDTHH:mm"`.
  - `collides ? \`${date}-${hh}${mm}\` : date`.
- `nextCalendarDate(date: string): string` — next `YYYY-MM-DD` (calendar increment via
  `Date.UTC(y, m-1, d+1)`; tz-independent since it operates on the date label only).

### 2. DB resolution — `src/server/meetings-resolve-logic.ts` (+ integration test)

Lives in a `*-logic.ts` (touches `#/db`); wrapped by a `createServerFn` in
`meetings.ts` per the server-module bundle rule.

`resolveMeetingKey(clubId, key): Promise<{ meetingId, urlKey, siblings } | null>`
- Load `club.timezone`.
- `date` kind → `[start, end) = [zonedWallTimeToUtc(`${date}T00:00`, tz),
  zonedWallTimeToUtc(`${nextCalendarDate(date)}T00:00`, tz))`; select meetings in the
  club within `[start, end)` ordered by `scheduledAt asc`. Resolved = earliest;
  `siblings` = the rest.
- `instant` kind → `at = zonedWallTimeToUtc(`${date}T${hh}:${mm}`, tz)`; select the
  club meeting with `scheduledAt = at`.
- `uuid` kind → select the club meeting by id.
- none → `null`.
- **Always** compute the resolved meeting's own `urlKey` from *its* club-local date:
  count club meetings sharing that local date; `urlKey = meetingUrlKey(scheduledAt,
  tz, count >= 2)`. This makes the detail payload's own present/print self-links
  correct regardless of whether the page was reached by UUID, bare date, or `-HHmm`.

Converting midnights independently through `zonedWallTimeToUtc` makes DST-boundary
days correct (they aren't 24h apart).

### 3. Route loaders (accept the key)

Three public routes resolve `key → meetingId` first, then reuse existing loaders:
- `src/routes/club.$clubId.meeting.$meetingId.tsx`
- `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`
- `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

Each `beforeLoad`/loader: call the `resolveMeetingKey` server fn with the already-
resolved club UUID + `params.meetingId`; `notFound()` on null; feed the resolved id
into `loadMeetingDetail` / the present/print loaders as today.

`getMeeting` / `getPublicMeeting` validators stay UUID (they receive the *resolved*
id). No behavior change downstream.

### 4. Link builders (emit the date key)

Meeting payloads gain a computed `urlKey`, and every link site passes `urlKey` as the
`$meetingId` param instead of the raw id:
- `src/components/club/meeting-link.tsx` — shared meeting link.
- `src/lib/meeting-nav.ts` (+ `meeting-nav.test.ts`) — prev/next nav.
- `src/components/club/meeting-view-actions.tsx` — present/print buttons.
- `src/routes/club.$clubId.index.tsx` — meeting-list links.
- `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` / `.print.tsx` — the
  back/print cross-links.
- `src/components/share-link-button.tsx` — caller already passes an app-relative path;
  the path is built from `urlKey`.

**Computing `collides` for lists:** list loaders already fetch a club's meetings, so
group in JS by club-local date (`utcToZonedWallTime(...).slice(0,10)`) and mark any
date with 2+ meetings as colliding — no extra query. For a single-meeting detail
payload, `resolveMeetingKey` already knows the siblings, so it returns the correct
`urlKey` (suffixed iff siblings exist).

## Data flow

```
emit:   meeting row ──utcToZonedWallTime+collides──▶ urlKey ──▶ Link params.meetingId
resolve: URL param ──parseMeetingKey──▶ {date|instant|uuid}
                    ──resolveMeetingKey(clubId,key)──▶ meetingId ──▶ loadMeetingDetail
```

## Error handling / edge cases

- **Unknown / malformed date** → `notFound()` (same page as an unknown UUID today).
- **DST-boundary day** → correct: each local midnight converts independently.
- **Double-header (2+ same local day)** → all emit `-HHmm`; a bare-date URL still
  resolves to the earliest and shows an "also this day →" link to the sibling(s).
- **Archived club** → unchanged: `resolveClubOrRedirect` already `notFound()`s before
  meeting resolution runs.
- **Old UUID link** → resolves and renders as-is; no redirect.

## Testing

- `meeting-url.test.ts` (unit): `parseMeetingKey` across all kinds incl. invalid;
  `meetingUrlKey` collide/no-collide; `nextCalendarDate` incl. month/year rollover.
- `meetings-resolve-logic.integration.test.ts`: date resolves to the day's meeting;
  tz correctness (meeting whose UTC date ≠ local date resolves under the *local* date);
  double-header → bare date returns earliest + siblings, `-HHmm` returns the exact one;
  uuid still resolves; unknown → null.
- `meeting-nav.test.ts`: nav `to`/params carry `urlKey`, not the raw id.
- Guard: `server-modules.guard.test.ts` already enforces the logic-file split for the
  new `meetings-resolve-logic.ts`.

## Rollout

Single PR, no migration, no data backfill. Additive and backward-compatible: UUID
links keep working; date links start being emitted the moment it ships.
