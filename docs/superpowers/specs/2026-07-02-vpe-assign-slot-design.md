# VPE assign-to-member, speaker TBA, and speech-details editing

**Date:** 2026-07-02
**Status:** Approved (design)
**Branch:** `feat/vpe-assign-slot`

## Problem

Role sign-up is entirely self-serve: every claim path hard-codes the assignee to the current
member (`memberId: currentMemberId`). A VPE/admin cannot assign a role to *another* member.
The backend already supports arbitrary assignment (`claimSlot` / `reassignSlot` take any
`memberId`, trust-guarded to club roster members); it just isn't exposed in the UI.

A second, coupled gap surfaced during design: **speaker slots require a speech title up front**,
but members routinely claim a speaking slot before they know their topic — and there is **no way
to edit speech details after claiming** (details are written only at claim time; changing them
means release + re-claim). So "assign now, fill details later" isn't currently possible.

## Goal

1. Let a VPE/admin assign an open role to a member, or reassign a filled role to a different
   member, from the authed meeting view, via a searchable member picker.
2. Allow any speaker slot to carry a placeholder speech title (**"TBA"**) so a slot can be
   filled before the speech is known.
3. Add an **edit speech details** capability so TBA (or any title) can be corrected later — by
   the assignee (their own slot) or a VPE (any slot).

## Non-goals

- No role-management / permissions overhaul. Backend stays trust-based (guarded only by
  `requireMemberInClub`), consistent with existing `claim` / `release` / `take over`. Who-sees-what
  is a **UI** concern (`canManage`, or "own slot").
- No activity-log entry for speech-detail edits (would need a new `activityActionEnum` value +
  migration for a low-stakes edit).
- No evaluator-pairing changes: an evaluator evaluates a *slot/speech*, not a person, so reassigning
  a speaker does not touch the eval link (the displayed speaker name follows `assigneeName`).

## Decisions (from grilling)

1. **Scope:** assign open slots **and** reassign filled slots.
2. **Picker candidates:** all **active** members. Members **unavailable for this meeting** and
   members **already holding a role this meeting** are **flagged, not blocked** (small clubs
   legitimately double-up; a VPE may knowingly override availability).
3. **Speakers unified on TBA:** assigning/reassigning **any** slot type is a single member-pick.
   Speaker slots default `speechTitle` to `"TBA"`; no speech-detail form in the assign flow.
4. **Landing status:** a direct assignment lands as `claimed` (VPE can `confirm` separately).
5. **Reassign resets:** `reassignSlot` sets `status: "claimed"` and, for speaker slots, resets
   `speakerDetails` to `{ speechTitle: "TBA" }`. Applies to the shared "take over" path too — a new
   holder hasn't been confirmed and isn't giving the previous speaker's speech.
6. **Self-serve claim relaxed:** `speechTitle` is optional; empty → `"TBA"`.
7. **Edit speech details:** new capability; assignee edits own slot, VPE edits any slot.
8. **Picker style:** searchable shadcn `Command` in a `Popover`.

## Architecture

### Backend

**`src/server/meetings.ts` — `loadMeetingDetail`**
- Add `roster: { id: string; name: string }[]`: **active** members of the meeting's club, ordered by
  name. Populated **only when `canManage`**; otherwise `[]`. Keeps the full member list out of the
  public/unauthenticated `getMeeting` payload (today only assigned names leak to anon callers).

**`src/server/slots.ts` — schema + `claimSlot`**
- `speakerDetailsSchema.speechTitle`: drop `min(1)`; make the field optional.
- `claimSlot`: remove the "Speaker roles require speech details before claiming" throw. For speaker
  slots, always upsert a `speakerDetails` row, normalizing the title: `speechTitle?.trim() || "TBA"`.
  Non-speaker slots unchanged.

**`src/server/slots.ts` — `reassignSlot`**
- In the update, also set `status: "claimed"` (alongside `assignedMemberId`).
- If the slot is a speaker role, upsert `speakerDetails` to `{ speechTitle: "TBA" }` (clearing
  project/pathway/level/min/max). Requires selecting `isSpeakerRole` in the slot lookup (join
  `roleDefinitions`, as `claimSlot` already does).
- Shared with the self-serve "take over" flow; the resets apply there too.

**`src/server/slots.ts` — new `updateSpeakerDetails`**
- `createServerFn` POST; schema `{ slotId, actorMemberId, speakerDetails }`.
- Trust guard: `requireMemberInClub(actorMemberId, slot.clubId)`. Verify the slot is a speaker role
  (else throw). Upsert `speakerDetails`, normalizing empty title → `"TBA"`. No activity log.
- PUBLIC/trust-based like its siblings.

### Frontend

**New component: `src/components/club/assign-slot-sheet.tsx`**
- Props: `slot`, `roster: { id; name }[]`, `assignments`, `unavailableIds`, `actorMemberId`,
  `onOpenChange`, `onAssigned`.
- Searchable member picker (shadcn `Command` in a `Popover`). Each row shows the member name plus,
  where applicable, a muted **"Not available"** tag (from `unavailableIds`) and/or their **current
  role** this meeting (from `assignments` — computed from loaded slots). Flagged members sort after
  unflagged ones but remain selectable.
- On submit, dispatches via `resolveAssignAction(slot)`:
  - open → `claimSlot({ slotId, memberId: chosen, actorMemberId, speakerDetails })` where
    `speakerDetails` is `{ speechTitle: "TBA" }` for speaker slots, else omitted.
  - filled → `reassignSlot({ slotId, memberId: chosen, actorMemberId })`.
- No speech-detail fields (unified TBA). Lives in its own file to avoid growing the route module.

**New component: `src/components/club/edit-speech-sheet.tsx`**
- Props: `slot`, `actorMemberId`, `onOpenChange`, `onSaved`.
- Reuses the existing speech-detail fields (title + project name / pathway path / project level /
  min & max minutes), pre-filled from the slot's current `speakerDetails` (including "TBA").
- Submits `updateSpeakerDetails`. Empty title normalizes to "TBA" server-side.

**Route wiring — `_authed/meetings.$id.tsx` (VPE view)**
- Read `roster` from loader data; compute `assignments` (memberId → role label) and reuse
  `unavailableMemberIds`.
- Gated on `canManage`: **"Assign…"** on open slots, **"Reassign…"** on filled slots → open
  `AssignSlotSheet`. **"Edit speech"** on any speaker slot → open `EditSpeechSheet`. Existing self
  "Claim" / confirm / speaker-slot management controls stay.
- On success, `router.invalidate()`.

**Route wiring — `club.$clubId.meeting.$meetingId.tsx` (self-serve member view)**
- Relax self-claim: the speaker claim sheet's title field becomes optional (empty → "TBA").
- Show **"Edit speech"** on a speaker slot only when it is the viewer's **own** slot
  (`slot.assigneeId === myId`) → open `EditSpeechSheet`.

### Testable seams

- **`resolveAssignAction(slot)`** — pure helper in `src/lib/agenda.ts` (tested in
  `src/lib/agenda.test.ts`): open → `{ kind: "claim", speakerTba: slot.isSpeakerRole }`;
  filled → `{ kind: "reassign" }`.
- **`buildPickerRows(roster, slots, unavailableIds)`** — pure helper returning each candidate with
  `{ id, name, unavailable, currentRole }` and flagged rows sorted last. Unit-tested.

## Testing

- **Unit:** `resolveAssignAction` (open/filled × speaker/non-speaker); `buildPickerRows`
  (unavailable + already-assigned flagging and sort order).
- **Integration** (`meeting-manage.integration.test.ts` / sibling):
  - VPE assigns an open non-speaker slot → `claimed`, assignee set, `claim` logged.
  - VPE assigns an open speaker slot → `claimed`, `speakerDetails.speechTitle === "TBA"`.
  - Reassign a filled speaker slot → assignee changed, `status === "claimed"`,
    `speechTitle === "TBA"`, `reassign` logged with `fromMemberId`/`memberId`.
  - `updateSpeakerDetails` updates title/project; empty title → "TBA".
  - `loadMeetingDetail` returns `roster: []` for a non-manager, populated for a manager.
- **Update existing tests** in `claim.integration.test.ts` that assert the removed
  "speaker requires details" throw and/or that reassign preserves status.
- `bun run check` (Biome) and `bun run build` (types) clean.

## Risks

- `reassignSlot` and `claimSlot` are shared with the self-serve flows; the status/TBA resets and the
  relaxed title change member-visible behavior. Covered by updating the affected tests above.
- Widening `getMeeting` output only under `canManage` must be verified so the anon payload is
  unchanged.
