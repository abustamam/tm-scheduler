# Manage a meeting: edit meta + variable speakers — Design

**Date:** 2026-07-01
**Branch:** `feat/manage-meeting`

## Problem

Two gaps make a scheduled meeting hard to run:

1. **No way to edit meeting meta.** Theme, Word of the Day, location, notes, and time
   are set once in `createMeeting` and can never be changed. (The `meeting_edit`
   activity action already exists, anticipating this.)
2. **Speakers are fixed at 3.** `createMeeting` calls `generateSlotRows(defs)` off the
   club's role template, where "Speaker" has `defaultCount: 3`. Real meetings vary — some
   weeks have 1–2 speakers, sometimes 0.

## Permissions

Both features are **admin/VPE-only**, behind auth (`requireClubRole(admin/vpe)`), same as
`createMeeting`. Roster members (incl. the meeting's Toastmaster) don't sign in; letting
the Toastmaster self-serve is deferred to **#67**.

## Surface

Both live on the authed meeting page `src/routes/_authed/meetings.$id.tsx`, which already
loads `getMeeting` → `{ meeting, slots, canManage, ... }` and renders slots grouped by
category. Manage affordances render only when `canManage` is true.

## Feature 1 — Edit meeting meta

- **Server:** `updateMeeting` in `src/server/meetings.ts` (POST, `requireClubRole(admin/vpe)`).
  - Input: `{ meetingId, clubId, scheduledAt, theme?, location?, wordOfTheDay?, notes? }`
    (same field set as `createMeetingSchema`).
  - `scheduledAt` is an HTML `datetime-local` value re-interpreted in the club timezone via
    the existing `zonedWallTimeToUtc(scheduledAt, club.timezone)` (reschedule supported).
  - Empty strings normalize to `null` (matches create).
  - Logs `meeting_edit` activity with `{ before, after }` of the changed fields.
  - **Reschedule is included:** `scheduledAt` is editable. Roles/claims are keyed to
    `meetingId` (not time) so they carry over untouched; member availability is NOT
    auto-cleared on a time change (VPE's call to re-communicate).
- **UI:** an **Edit** button on the meeting header (rendered when `canManage`) opens a
  dialog pre-filled with current values (same inputs as `admin/meetings.new.tsx`, incl.
  date/time). On save, `router.invalidate()`.
- **Activity formatting:** `meeting_edit` (and `meeting_create`) currently fall through to
  the raw-string default in `src/lib/activity-format.ts`. Add a `meeting_edit` case that
  renders readable summaries, including the slot-change `detail` variants from Feature 2
  (see below).
- **Out of scope:** meeting status (cancel/complete) — not part of "meta"; leave for later.
  Meeting **duration/length** (60 vs 90 min) is its own issue **#68**.

## Feature 2 — Variable speakers (add / remove / reorder on the agenda)

- **Identifying the roles (per club):**
  - Speaker role = the `roleDefinitions` row with `isSpeakerRole = true`. Assume exactly
    one; if 0 → error, if >1 → operate on the lowest-`sortOrder` one.
  - Paired evaluator role = the `category = "evaluator"` row with the **highest
    `defaultCount`** (tie → lowest `sortOrder`). For the standard template this is
    "Evaluator" (3), not "General Evaluator" (1). This is a **heuristic**, not a modeled
    link — General Evaluator is intentionally a distinct, unique role. Real 1:1
    speaker↔evaluator linking (`evaluatesSlotId`) is NOT populated for created meetings
    today (only the seed sets it) and is left as a future enhancement. If no evaluator role
    exists, adding/removing a speaker just skips the evaluator.
- **Server** (in `src/server/slots.ts`, POST, admin/VPE):
  - `addSpeakerSlot({ meetingId, actorMemberId? })` — insert one Speaker slot at the next
    `slotIndex` for that role, **and** one paired Evaluator slot at its next `slotIndex`
    (count parity). Wrapped in a transaction. Logs activity.
  - `removeSpeakerSlot({ meetingId, actorMemberId? })` — remove the **unclaimed** (`status
    = "open"`, no `assignedMemberId`) Speaker slot with the **highest `slotIndex` among
    unclaimed** slots, **and** one unclaimed paired Evaluator slot (highest index).
    Transaction. Logs activity.
    - If there are no unclaimed Speaker slots → throw `"Release a speaker before removing a
      slot."` (never yanks an assigned member).
    - Removing the paired evaluator is best-effort: if no unclaimed evaluator slot exists,
      remove only the speaker slot (don't block on it).
  - `moveSpeakerSlot({ slotId, direction: "up" | "down", actorMemberId? })` — **swap
    `slotIndex`** with the adjacent Speaker slot in that direction (the neighbor by current
    slotIndex order among that role's slots), in a transaction. Works on claimed AND
    unclaimed speakers (reorder is position-only; assignee/`speakerDetails`/`claimedAt` ride
    on the slot row). No-op/error if there is no neighbor in that direction. **Evaluators
    are untouched.** Logs activity.
  - **0 speakers is allowed** server-side.
- **`slotIndex` is stable identity — never renumber.** The season grid
  (`season-grid-logic.ts`) keys its row axis on `${roleDefinitionId}:${slotIndex}`. Add
  appends at `max+1`; remove deletes the tail unclaimed slot; reorder swaps two indices.
  Removing a non-tail slot can leave a cosmetic label gap ("Speaker 1, Speaker 3") — that's
  accepted, and the VPE can reorder to tidy it. We do NOT auto-renumber (that would move a
  claimed slot's season-grid row).
- **"Auto-track evaluators" = count parity** (add speaker → +1 evaluator; remove speaker →
  −1 unclaimed evaluator). Not link-based, per the heuristic note above. Reorder does not
  touch evaluators.
- **Activity logging (all three) reuses `meeting_edit`** (targetType `meeting`,
  targetId `meetingId`) with a `detail` discriminator
  `{ change: "speaker_added" | "speaker_removed" | "speaker_reordered", … }`; the
  `activity-format.ts` `meeting_edit` case renders each variant ("added a speaker",
  "removed a speaker", "reordered speakers"). No enum-`ALTER` migration.
- **UI** (Speakers group on `meetings.$id.tsx`, when `canManage`):
  - **+ Add speaker** button.
  - A small **Remove** control on each **unclaimed** speaker slot (claimed slots show no
    remove; the VPE releases first).
  - **↑ / ↓** reorder controls on each speaker slot (disabled at the ends).
  - **0-speaker warning:** if a Remove would drop the meeting to **zero** speaker slots, a
    confirm dialog warns ("This meeting will have no speakers. Continue?") before calling
    the server.
  - After any add/remove/reorder, `router.invalidate()`.
- **No status/past gating:** manage affordances show whenever `canManage`, on any meeting
  (meeting status is never anything but `scheduled` today; adding past/future gating would
  be new logic the app doesn't otherwise have).

## Testing

- **Unit** (`src/lib/` pure logic): a small helper that, given the club's role defs, picks
  the speaker role and paired evaluator role (the heuristic) — unit-tested with the
  standard template + edge cases (no evaluator, ties, multiple speaker roles).
- **Integration** (following `slots.confirm.test.ts` / `claim.integration.test.ts` and the
  `meetings` patterns, against the `tm_test` DB): `updateMeeting` writes fields (incl.
  reschedule) + logs `meeting_edit`; `addSpeakerSlot` adds a paired speaker+evaluator;
  `removeSpeakerSlot` removes only unclaimed slots (highest unclaimed index), errors when
  all speakers are claimed, and removing down to 0 succeeds server-side; `moveSpeakerSlot`
  swaps adjacent speaker indices (claimed slot included), leaves evaluators untouched, and
  no-ops/errors at the ends.
- **Formatter** unit test: `activity-format.ts` renders the `meeting_edit` `detail`
  variants (`speaker_added` / `speaker_removed` / `speaker_reordered`) as readable lines.
- `bun run check`, `bun run build`, full `bun run test` green; `server-modules.guard.test.ts`
  still passes (new server fns keep db logic in the createServerFn handlers / a `*-logic`
  sibling as needed).

## Related issues (filed)

- **#66** Edit role descriptions + add custom club roles (the club-level role *template*,
  vs this issue's per-meeting *slots*).
- **#67** Investigate self-serve editing for the meeting's Toastmaster (no-auth path).
- **#63** Officer position modeling (answers "how to update officer role" — already editable
  as free-text `members.office` via the member Edit dialog; #63 is the modeled version).
- **#68** Meeting duration/length (60 vs 90 min) — a duration field would join the
  meeting-edit dialog built here.

## Out of scope

- Non-VPE (Toastmaster/self-serve) editing → #67.
- Editing the club role template / custom roles / descriptions → #66.
- Meeting duration/length → #68.
- Real `evaluatesSlotId` speaker↔evaluator linking for created meetings.
- Meeting status transitions (cancel/complete).
- Varying evaluator count independently of speakers (only speaker-driven parity).
