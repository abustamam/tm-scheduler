# Per-meeting "Can't go" chip on the sign-up grid

**Date:** 2026-07-13
**Status:** Approved
**Issue:** go-live blocker — the public club home (`/club/:slug`) has no way for a
member to say they won't attend a meeting.

## Problem

The public club home defaults to the **Roles × Meetings** orientation of the
season grid. Declining a meeting is only possible today by (a) switching to the
Members × Meetings orientation and tapping your own row cell (#204), or (b)
opening the meeting's detail page and using its availability toggle. Neither is
discoverable from the main screen.

All server machinery already exists and is reused unchanged:

- `setAvailability` / `clearAvailability` (`src/server/availability.ts`) —
  public, trust-guarded via `requireMemberInClub`, meeting-lock checked.
- `markUnavailableReleasing` — decline + atomically release held roles (#204).
- `SeasonGridData.unavailable` already carries member × meeting unavailability;
  `data.cells` carries slot assignments. **Zero server changes.**

## Design

### Placement

A small availability chip in **each meeting's column header** of `SeasonGrid`
(`src/components/club/season-grid.tsx`), below the date and the "3 open / full"
status line. Because the header is shared, the chip appears in both grid
orientations and on both surfaces that pass an acting member: the public club
home (`/club/:slug`, where `RequireMember` guarantees a picked member) and the
signed-in `/schedule` page.

### Visibility

The chip renders only when:

- `currentMemberId` and `clubId` are both set on the grid, and
- the meeting is upcoming — not `isPast`, not `isCompleted` (locked).

Past/locked columns show no chip (matches the `availabilityEditable` rule the
Members × Meetings cells already use).

### States & behavior

All mutation handlers already exist in `SeasonGrid`; the chip only adds a
second entry point to them.

| State | Look | Click |
| --- | --- | --- |
| Available, no role held | muted outline chip "Can't go" | `markUnavailable(meetingId)` → toast "Marked unavailable." with **Undo** |
| Available, holds ≥1 role | same chip | opens the existing "Mark yourself unavailable?" confirm dialog → `markUnavailableReleasing` |
| Declined | filled chip "Not going ✕", title "Tap if you can make it after all" | `clearUnavailable(meetingId)` → toast with **Undo** |
| Mutation in flight | spinner in the chip (`busyMeetingId`) | disabled |

### View-model

New pure helper in `src/lib/season-grid-view.ts`:

```ts
memberMeetingStatus(data: SeasonGridData, memberId: string | null):
  Map<meetingId, { declined: boolean; heldRoleLabels: string[] }>
```

Computed from `data.unavailable`, `data.cells`, and `data.rows` (role labels
for the confirm-dialog text). Unit-tested in `season-grid-view.test.ts`.

### HTML structure

The header cell content is currently one `<Link>`; a `<button>` cannot nest
inside an anchor, so the chip renders as a sibling below the link inside the
`<th>`.

### In-scope fix: public header link

The date header links to `/meetings/$id` — a signed-in route — so on the
public page tapping a date bounces members to sign-in. Fix in the same cell:
`SeasonGrid` gains an optional `clubSlug` prop. When set (public club home
passes its slug param), date headers link to
`/club/$clubSlug/meeting/$meetingId`; when absent (signed-in `/schedule`),
they keep linking to `/meetings/$id`. Note the existing `clubId` prop is the
club **uuid** (for the availability server fns) — the public route param is
the slug, hence the separate prop.

## Error handling

Unchanged from existing handlers: failures surface as `toast.error` with the
server message; the lock guard (`assertMeetingNotLocked`) and
`requireMemberInClub` reject stale/forged calls server-side.

## Testing

- Unit: `memberMeetingStatus` cases — declined, holds-role (labels), free,
  null member ⇒ empty map.
- Server fns already covered by `availability.integration.test.ts`.
- Manual browse-verify on the public page: pick a name → decline a free
  meeting → undo → decline a meeting where a role is held (confirm dialog,
  role released, grid updates) → date header links to the public meeting view.

## Out of scope

- No schema/server changes, no new endpoints.
- No decline surface on the meeting card list ("Your upcoming roles").
- No notification/digest of declines (VPE sees availability via existing
  views/activity log).
