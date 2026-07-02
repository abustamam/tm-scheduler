# Member meeting nav strip

**Date:** 2026-07-02
**Surface:** Public member view — `/club/$clubId/meeting/$meetingId`

## Problem

A member who wants to sign up across several meetings has to bounce back to the
club home between each one. There's no way to move directly from one meeting's
agenda to the next. The goal is low-friction, mobile-first navigation between
meetings — closer to the "scan the columns" feel of the shared spreadsheet.

## Solution

A horizontal, swipeable **date strip** pinned just under the meeting title. Each
upcoming meeting is a tab showing a short date; the current meeting is
highlighted; tapping a date navigates to that meeting's agenda. On load the strip
auto-scrolls so the active date is centered/visible.

Scope decisions (approved):

- **Pattern:** date strip (tabs), not prev/next or a dropdown.
- **Included meetings:** upcoming only (same set as the club home list), plus the
  currently-viewed meeting even if it is in the past (see edge cases).
- **Open-roles hint:** a small dot on a date when that meeting still has open
  slots (`openSlots > 0`), so members can see at a glance where help is needed.

## Data flow

The meeting-page loader currently fetches only the single meeting via
`getMeeting({ data: meetingId })`. Extend it to *also* call the existing
`listUpcomingMeetings({ data: clubId })`. No new server function is required.

**The strip fetch must be non-fatal.** The core agenda is the critical content;
the nav strip is an enhancement bolted onto the same page. Fetch the upcoming
list so that a failure degrades to "no strip" rather than taking down the
agenda — e.g. `Promise.allSettled([...])` (or a `.catch(() => [])` on the list
call). Never let a strip-data failure fail the route loader. `getMeeting` keeps
its own error behavior unchanged.

`listUpcomingMeetings` already returns, per meeting: `id`, `scheduledAt`,
`timezone`, `theme`, `openSlots`, `totalSlots`. That is everything the strip
needs, and it returns **all** upcoming meetings (no cap) ordered by
`scheduledAt` ascending — the strip shows them all (see Out of scope re: caps).

`getMeeting` returns the full `meeting` row, so `meeting.id` and
`meeting.scheduledAt` (a `Date`) are the `current` input to the helper below.

The loader passes the current meeting plus the (possibly empty) upcoming list
into a pure helper `buildMeetingNavItems(...)` (below) and hands the resulting
items to the view.

## Components

### `buildMeetingNavItems` (pure, testable)

Location: `src/lib/meeting-nav.ts`

```
buildMeetingNavItems(
  current: { id: string; scheduledAt: Date | string },
  upcoming: Array<{ id: string; scheduledAt: Date | string; openSlots: number }>,
  timezone: string,
): MeetingNavItem[]

type MeetingNavItem = {
  meetingId: string;
  label: string;        // short date, e.g. "7/09" (M/D) in club timezone
  isCurrent: boolean;
  hasOpenRoles: boolean;
};
```

Behavior:

- Union the `current` meeting into the `upcoming` set keyed by `id` (dedupe — the
  current meeting is normally already present).
- Sort ascending by `scheduledAt`.
- `isCurrent` is true for the item whose `meetingId === current.id`.
- `hasOpenRoles` is `openSlots > 0`; the current meeting, if it was not in the
  upcoming set (a past meeting), has no `openSlots` data → `hasOpenRoles: false`.
- `label` is a compact, **date-only** label formatted in `timezone` as
  `Aug 13` (`Intl.DateTimeFormat` with `{ month: "short", day: "numeric" }`).
  Deliberately *not* numeric `M/D`: the existing formatters run under the
  runtime's default locale, where `8/13` can render/parse as `D/M`. `Aug 13` is
  compact enough for the strip and unambiguous across locales. Add this as a
  small `formatShortDate(value, timeZone)` beside `formatMeetingDate` in
  `src/lib/format.ts` (same `Intl` approach, weekday dropped). No theme or
  meeting number on the tab — the meeting title above the strip carries that.

### `MeetingNavStrip` (presentational)

Location: `src/components/club/meeting-nav-strip.tsx`

Props: `{ clubId: string; items: MeetingNavItem[] }`.

- Renders a horizontal `overflow-x-auto` row with scroll-snap; each item is a
  `<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId }}>`.
- Active item (`isCurrent`) gets highlighted styling (underline/filled tab).
- `hasOpenRoles` renders a small dot on the tab.
- **Auto-scroll on active change, not on mount.** Navigating between meetings
  stays on the same route (only the `$meetingId` param changes), so the strip
  re-renders rather than remounts — a mount-only effect would never re-center.
  Run the scroll effect keyed on the active `meetingId`, and use
  `scrollIntoView({ inline: "nearest", block: "nearest" })` so it only scrolls
  when the active tab isn't already fully visible (no jump when the user tapped
  a tab that was already on screen; rescues the active tab when arriving via a
  link, back/forward, or a tap near the strip edge).
- If `items.length <= 1`, render nothing (nothing to navigate to).

### Route wiring

`src/routes/club.$clubId.meeting.$meetingId.tsx`

- Loader: `Promise.all([getMeeting(...), listUpcomingMeetings(...)])`, then
  `buildMeetingNavItems(...)`; return the items alongside existing loader data.
- View: drop `<MeetingNavStrip clubId={clubId} items={navItems} />` into the
  header, below the title/date line, above the availability + share/print row.

## Edge cases

- **Current meeting already in the past (common, not rare):**
  `listUpcomingMeetings` filters `scheduledAt >= now`, so a meeting happening
  *today but already started* is excluded from the upcoming set. A member
  viewing that meeting must still see and jump from it — the helper unions the
  current meeting into the list (deduped by id) and sorts by date, so it always
  appears (leftmost / earliest) and is highlighted; its tab shows no open-roles
  dot (no `openSlots` data).
- **Single meeting:** strip renders nothing.
- **Strip fetch failed:** loader degrades to an empty list → strip renders
  nothing; agenda unaffected.
- **Wrong club guard:** unchanged — the loader already `throw notFound()` when
  `meeting.clubId !== params.clubId`.

## Testing

- Unit test `buildMeetingNavItems` (`src/lib/meeting-nav.test.ts`): ordering by
  date, current-meeting union/dedupe, `isCurrent` flag, `hasOpenRoles` mapping,
  past-current-meeting union, and `Aug 13` label formatting in a fixed timezone.
- `MeetingNavStrip` is presentational with no new server logic; covered
  indirectly. No integration test needed (no new server function).

## Out of scope

- **Capping the strip length.** Show all upcoming meetings; horizontal scroll +
  auto-center handles long seasons. A cap risks hiding the target meeting and is
  speculative until a club actually schedules enough to warrant it.
- Editable/assign-in-place grid (separate feature).
- A member "all open roles across meetings" list (separate feature).
- Any change to the VPE season grid.
