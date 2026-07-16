# Assign roles from the Members × Meetings grid

**Status:** approved 2026-07-16

## Problem

Officers build the meeting agenda in a spreadsheet where each member × meeting
cell is a dropdown of roles. GavelUp's sign-up sheet has a **Members × Meetings**
view, but its cells are read-only — you can only *see* who holds what, not
assign from there. Assignment currently lives only on the meeting page
(`AssignSlotSheet`, member-picker-per-slot). This adds the inverse — a
**role-picker per member × meeting cell** — so the grid becomes the editable
board officers already think in.

## Decisions (from brainstorming)

- **Multiple roles per member per meeting are allowed** (the data model already
  permits it; the members cell already aggregates as `"SP1"`, `"TMR +1"`). The
  cell editor is therefore a **multi-toggle picker**, not a single-value dropdown.
- **Reassign bumps the current holder.** Picking a slot held by someone else
  moves it; **no modal confirm** — instead the picker **labels each taken slot
  with the current holder** (`"Speaker 1 · Alex Rivera"`) so it's an informed
  click, and an **undo** toast follows.
- **Who:** officers/admins on any row; members on their own row (mirrors the
  "mark unavailable" control, gated by `canManageOthers` + own-row).
- **Speaker slots assign the slot only** (no speech-details prompt here), but
  incomplete speeches are surfaced (see below).

## Design

### 1. `MemberMeetingRolePicker` (new component)

A popover anchored to a members-orientation cell. Inputs: the target member
(id + name), the meeting, the meeting's slots (derived from grid data), the
acting member id, and whether the viewer may act (own row or `canManageOthers`).

Renders the meeting's role slots grouped by category. Per slot, one of:

- **open** → "Assign" → `claimSlot({ slotId, memberId: target, actorMemberId })`
- **held by the target member** → checked → "Release" → `releaseSlot({ slotId, actorMemberId })`
- **held by someone else** → shows `"· {holderName}"` → "Reassign" →
  `reassignSlot({ slotId, memberId: target, actorMemberId })`

Plus a **"Not available"** toggle → `setAvailability` / `markUnavailableReleasing`
(the officer-attributed availability functions already added). Each action is
followed by an undo toast and `onChanged()` (refetch).

A pure helper `slotAction(slot, targetMemberId) → "assign" | "release" | "reassign"`
is unit-tested; the server functions it dispatches to are already covered.

### 2. `season-grid.tsx` wiring

In the **members** orientation, a cell for an **upcoming** meeting (not
past/locked) becomes a trigger that opens the picker when
`isOwnRow || canManageOthers`. The cell keeps its current display
(`SP1` / `TMR +1` / `NA` / blank). Roles orientation is unchanged.

### 3. Speaker-without-details surfacing

Assigning a member to a **speaker** slot creates an assignment with no linked
speech (`role_slots.speech_id = null`). Two nudges:

- **Assign-time toast:** e.g. *"Assigned as Speaker 2 — add speech details"*,
  with an action/link to where details are entered (`updateSpeakerDetails` via
  the existing edit-speech flow / the meeting page).
- **`/me` reminder:** a "Speeches needing details" callout listing the viewer's
  **upcoming speaker commitments with no speech title** (already available from
  `listMyCommitments`: `isSpeakerRole && !speechTitle`), each linking to add
  details. Shown above/near "My roles"; hidden when there are none.

## Server

**No new server functions.** Reuses `claimSlot`, `reassignSlot`, `releaseSlot`
(all public, trust-guarded, already take `actorMemberId`) and the
`setAvailability` / `markUnavailableReleasing` added for officer-marked
availability. Officer-assigns-another is the same trust-guard model as the
mark-unavailable feature.

## Testing

- Unit: `slotAction` helper (open→assign, own→release, other→reassign).
- Unit/integration: existing claim/reassign/release + availability tests already
  cover the server side; no new server logic.
- Manual/browser: as an officer, open a member cell, assign a role, reassign a
  taken slot (holder shown), release, mark not-available; assign a speaker slot
  and confirm the toast + the `/me` "needs details" reminder.

## Out of scope

- Capturing speech title/project at assign time (kept on the meeting/member page).
- Drag-and-drop between cells; bulk assignment.
- Changing the Roles × Meetings view or the public sign-up sheet's self-claim.
- One-role-per-member enforcement (multiple roles are intentionally allowed).
