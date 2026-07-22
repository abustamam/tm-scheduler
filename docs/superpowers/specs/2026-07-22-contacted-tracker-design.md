# Contacted tracker — design

**Date:** 2026-07-22
**Status:** Approved (brainstorm), pending implementation plan
**Issue:** [#340](https://github.com/abustamam/tm-scheduler/issues/340)
**Owner role:** VP Education / President (officer outreach)

## Problem

As VPE/President I contact people to see whether they're open to filling a role at
the next meeting. Today there's no way to remember **who I've already reached out
to**. The app already helps me *send* the ask — feature #37's "Nudge someone"
picker drafts a WhatsApp/Email "can you fill this role?" message ("the app drafts,
the VPE sends") — but it keeps no memory of it. So I lose track of who's been asked,
re-ask people, and can't see at a glance who's still left to contact.

## Decision (scope)

Track a single boolean per person per meeting: **contacted** or **not**. No
yes/no/maybe/decline states, no per-role outreach records. Role **assignment is the
other half of the signal** — assigning someone to a slot already means "contacted
about a role," so the flag only needs to capture the gap: people I've reached out to
who aren't assigned yet.

This is a **private officer tool** (admin/VPE only). Members and the public never see
who has been contacted — an unanswered "I asked Bob" is not something to show Bob or
a visitor.

The flag is a property of the (member, meeting) relationship and is surfaced across
the views the VPE already uses, rather than living on a single dedicated screen.

Stays on the right side of the project's "keep human roles human" stance: it aids the
human's outreach, it does not automate or replace it.

## Model — near-clone of `member_availability`

New table `meeting_outreach`:

```
meeting_outreach
  id           uuid pk
  meeting_id   uuid  → meetings(id)  on delete cascade
  member_id    uuid  → members(id)   on delete cascade
  created_at   timestamp             (= "contacted at")
  unique(member_id, meeting_id)      -- presence of row = "contacted"
  index(meeting_id)
```

- **Presence of a row = contacted; absence = not contacted.** Exactly the
  `member_availability` convention.
- **Per-meeting**, so each meeting starts with an empty set — no reset logic.
- *Who* marked it and *how* (nudge vs. manual) are recorded in `activity_log.detail`,
  **not** on the row, keeping it a pure boolean. Surfacing "asked by Jane" in the grid
  is a deliberate future follow-up, not part of this work.

### Derived states (computed at read time, no new fields)

Per (member, meeting):

- **assigned** — member holds ≥1 role slot → shown with the role; *implicitly
  contacted*, needs no `meeting_outreach` row.
- **contacted** — has a `meeting_outreach` row and is not assigned → "asked, no role
  yet."
- **not contacted** — neither.

"Who's left to ask" = active members who are neither assigned nor flagged.

## Server layer (mirrors `src/server/availability.ts`)

New `src/server/outreach.ts` exporting two `createServerFn`s (module exports only
server fns + types, per `server-modules.guard.test.ts`):

- `setContacted({ meetingId, memberId, clubId, via })` — idempotent insert
  (`onConflictDoNothing`).
- `clearContacted({ meetingId, memberId, clubId })` — delete the row.

Both:

- Guard **admin/VPE only** (the `read_write` officer capability), unlike the
  self-serve `setAvailability`. Reject non-admins server-side regardless of surface.
- `assertMeetingNotLocked(status)` — a completed meeting is locked (ADR-0012).
- Write `activity_log` with two new `activity_action` enum values `outreach_set` /
  `outreach_clear`, `targetType: "meeting"`, `detail: { memberId, via: "nudge" |
  "manual" }`. Add a corresponding line to `src/lib/activity-format.ts`.

Enum change ⇒ a Drizzle migration via `bun run db:generate` + `db:migrate`.

Any genuinely pure, testable logic (e.g. annotating the recruiting pool with the
contacted flag / deriving the "not contacted" list) goes in a sibling pure helper so
it's unit-testable without a DB.

## Read integration

- `loadSeasonGrid` gains an `includeOutreach` flag (parallel to the existing
  `includeContact`) → a `contacted: { memberId, meetingId }[]` set on
  `SeasonGridData`. Populated **only when the requesting user is an admin** of the
  club; the public loader (`loadPublicSeasonGrid`) **never** includes it. Note: the
  authed season grid is member-facing since #198, so this must gate on admin
  specifically, not merely on "authed."
- The meeting-agenda payload (meeting-viewer) gains `contactedMemberIds`, populated
  **only for admin viewers**. The shared `<MeetingAgenda>` component renders the
  toggle only when the viewer can mark contacted.

## UI surfaces (one flag, three views)

1. **Meeting-agenda view** (`src/components/agenda/meeting-agenda.tsx`) — a
   "contacted" toggle per member in the outreach/recruit area; assigned members shown
   as already handled; a compact "X contacted · Y still to ask" count. The component
   already assembles `roster`, `unavailableMemberIds`, and `roleByMemberId`; add
   `contactedMemberIds` alongside.
2. **Nudge picker** (`src/components/club/nudge-recruit-picker.tsx`) — annotate
   `RecruitTarget` with a `contacted` flag (next to `notAvailable` / `alreadyRole`),
   and make tapping the WhatsApp/Email draft fire `setContacted({ via: "nudge" })`
   fire-and-forget (thread the member/meeting/club ids + an `onContacted` callback
   through `NudgeButtons`). The manual toggle sits in the same popover.
3. **Season grid** (`src/components/club/season-grid.tsx` /
   `src/lib/season-grid-view.ts`) — a contacted marker (e.g. a dot/ring) on `free`
   member cells, spanning several upcoming meetings.

**Marking behavior (chosen):** *auto on nudge + manual.* Tapping a nudge draft
auto-marks contacted; a manual toggle everywhere covers asks made by phone / in
person / outside the app. Both write through the same `setContacted`/`clearContacted`
server fns.

## Visibility / authz

Admin/VPE only for **both read and write**. The contacted set must **not** appear on
the public `club/$clubId` season grid or public meeting view — same discipline as the
member-contact PII gate (contact info gated signed-in-only).

## Testing

- `src/server/outreach.integration.test.ts` mirroring `availability.integration.test.ts`:
  set is idempotent, clear removes, **non-admin is rejected**, **locked meeting is
  rejected**, activity rows written with the right action + detail.
- Unit test for the pure annotate/derive helper (contacted flag on targets; "not
  contacted" list).
- `server-modules.guard.test.ts` already enforces no `pg` leak from `outreach.ts`.

## Out of scope (YAGNI)

- No yes/no/maybe/decline states; no per-role outreach rows.
- No reminders / automation (keeps the "keep human roles human" line).
- No "who asked / via which channel" surfaced in the UI (captured in `activity_log`
  only).
- No member or public visibility.

## Build order

Land the model + server + read gating + **meeting-agenda toggle + nudge auto-mark**
first (the core loop where outreach happens); the **season-grid marker** can be a fast
follow if it helps split the work. (User approved all three together.)
