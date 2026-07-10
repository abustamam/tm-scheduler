# ADR-0012: Meeting lifecycle + agenda lock (close-out / reopen)

Status: Accepted

## Context

The `meeting_status` enum has always carried `scheduled` / `cancelled` / `completed`
(default `scheduled`), but nothing in the app ever transitioned a meeting's status — only
test fixtures set it. A meeting stayed `scheduled` forever and its agenda remained fully
editable indefinitely, on both the signed-in admin view and the public self-serve/TMOD view.
There was no way for an admin to say "this meeting has happened, stop changing it," and no
recorded lifecycle. See issue #150.

Speech "delivered" state is already **derived** from the meeting date being in the past
(ADR-0009); closing out a meeting is deliberately **not** about marking speeches delivered.

## Decision

Introduce a real meeting lifecycle with a single reversible transition and a lock invariant.

**Lifecycle:** `scheduled → completed` (admin **Complete**) and `completed → scheduled`
(admin **Reopen**). No new enum values or schema changes — the existing `completed` state is
reused. Cancelling (`cancelled`) stays out of scope (a separate concern).

- **Complete** sets `status = completed` and is guarded to the meeting's scheduled **date**
  being today or in the past (compared at day granularity in the club timezone) so an
  upcoming meeting can't be locked by accident.
- **Reopen** returns `status = scheduled` with **no date guard**, so an admin can amend a
  finished meeting and complete it again.
- Both are **manage-capability (admin) only** — gated by `requireClubRole(..., ["admin"])`,
  the same capability the signed-in view uses. Neither is offered on the public
  self-serve / TMOD surface.

**Lock invariant:** while `status = completed`, the meeting is read-only — every
agenda-mutating operation is **rejected server-side** (not merely hidden in the UI). Only
Reopen may change a completed meeting.

## Enforcement (the choke point)

The lock lives at the shared authorization/logic layer the mutations already funnel through,
so it is inherited rather than re-checked per handler:

- `assertMeetingNotLocked(status)` (in `meeting-authz-logic.ts`) throws
  `"This meeting is locked."` when the status is `completed`. This exact string is also the
  banner copy (`MEETING_LOCKED_MESSAGE` in `src/lib/meeting-lifecycle.ts`).
- `resolveMeetingAgendaAuthz` calls it after loading the meeting, so every mutation behind
  `requireMeetingAgendaEditor` inherits the lock: meta edit (`updateMeeting`) and
  add/remove/move speaker.
- The mutations that use the trust guard (`requireMemberInClub`) or admin guard
  (`requireClubRole`) instead of the agenda-editor path each assert the lock against the
  status they already load: claim, release, confirm/unconfirm, reassign (claim/takeover),
  update speaker details, add/remove role, and the availability toggle. Reassign asserts it
  under the row lock inside `reassignSlotCore`.

A direct server-fn call — not just a hidden button — therefore fails on a completed meeting.

## Presentation

- The meeting view (both signed-in and public) shows a banner reading exactly
  **"This meeting is locked."** and hides all mutation controls when completed.
- The **Complete / Reopen** control sits with the meeting-view admin actions (alongside
  Present / Print), admin-only. Complete appears only once the date is reached.
- The season grid marks a completed meeting distinctly (a "locked" indicator) so a finished
  meeting reads differently from a scheduled one.

## Consequences

- The lock is authoritative because it is server-side; the UI hiding is a convenience.
  Integration tests (`meeting-lifecycle.integration.test.ts`) prove the rejection at the
  logic/guard layer for the representative paths (agenda-editor authz, reassign, add/remove
  role) plus the date guard and the reopen round-trip.
- Speech-delivered derivation is unchanged (still date-based, ADR-0009). Completing is a
  lifecycle + lock concern only — it captures no attendance and no awards.
- The transition is fully reversible, so a mistaken Complete is a one-click Reopen away.
