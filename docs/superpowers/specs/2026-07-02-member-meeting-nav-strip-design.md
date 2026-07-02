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
`getMeeting({ data: meetingId })`. Extend it to also call the existing
`listUpcomingMeetings({ data: clubId })` in parallel with `Promise.all`. No new
server function is required.

`listUpcomingMeetings` already returns, per meeting: `id`, `scheduledAt`,
`timezone`, `theme`, `openSlots`, `totalSlots`. That is everything the strip
needs.

The loader passes the current meeting plus the upcoming list into a pure helper
`buildMeetingNavItems(...)` (below) and hands the resulting items to the view.

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
- `label` is a compact `M/D` date formatted in `timezone`.

### `MeetingNavStrip` (presentational)

Location: `src/components/club/meeting-nav-strip.tsx`

Props: `{ clubId: string; items: MeetingNavItem[] }`.

- Renders a horizontal `overflow-x-auto` row with scroll-snap; each item is a
  `<Link to="/club/$clubId/meeting/$meetingId" params={{ clubId, meetingId }}>`.
- Active item (`isCurrent`) gets highlighted styling (underline/filled tab).
- `hasOpenRoles` renders a small dot on the tab.
- On mount, scroll the active item into view (centered).
- If `items.length <= 1`, render nothing (nothing to navigate to).

### Route wiring

`src/routes/club.$clubId.meeting.$meetingId.tsx`

- Loader: `Promise.all([getMeeting(...), listUpcomingMeetings(...)])`, then
  `buildMeetingNavItems(...)`; return the items alongside existing loader data.
- View: drop `<MeetingNavStrip clubId={clubId} items={navItems} />` into the
  header, below the title/date line, above the availability + share/print row.

## Edge cases

- **Past-meeting link:** current meeting not in the upcoming set → helper unions
  it in so the strip still shows and highlights it; its tab shows no open-roles
  dot.
- **Single meeting:** strip renders nothing.
- **Wrong club guard:** unchanged — the loader already `throw notFound()` when
  `meeting.clubId !== params.clubId`.

## Testing

- Unit test `buildMeetingNavItems` (`src/lib/meeting-nav.test.ts`): ordering by
  date, current-meeting union/dedupe, `isCurrent` flag, `hasOpenRoles` mapping,
  past-current-meeting union, and `M/D` label formatting in a fixed timezone.
- `MeetingNavStrip` is presentational with no new server logic; covered
  indirectly. No integration test needed (no new server function).

## Out of scope

- Editable/assign-in-place grid (separate feature).
- A member "all open roles across meetings" list (separate feature).
- Any change to the VPE season grid.
