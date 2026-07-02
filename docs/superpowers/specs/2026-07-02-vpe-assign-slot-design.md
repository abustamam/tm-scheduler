# VPE assign-to-member on meeting slots

**Date:** 2026-07-02
**Status:** Approved (design)
**Branch:** `feat/vpe-assign-slot`

## Problem

Role sign-up is entirely self-serve: every claim path in both meeting views hard-codes
the assignee to the current member (`memberId: currentMemberId`). A VPE/admin has no way
to assign a role to *another* member — the intended workaround is to send that member their
member link and have them self-claim. The backend already supports direct assignment
(`claimSlot` / `reassignSlot` accept an arbitrary `memberId` and only trust-guard that it's a
club roster member), so the capability exists; it just isn't exposed in the UI.

## Goal

Let a VPE/admin, from the authed meeting view, assign an open role to a member or reassign a
filled role to a different member — via a searchable member picker gated to the VPE view.

## Non-goals

- No change to the self-serve member view (`club.$clubId.meeting.$meetingId.tsx`).
- No new server endpoints; reuse existing `claimSlot` / `reassignSlot`.
- No role-management / permissions overhaul. Gating is UI-only (`canManage`), consistent with
  the existing trust-based model for `claim` / `release` / `take over`.

## Decisions (from brainstorming)

1. **Scope:** assign open slots **and** reassign already-filled slots.
2. **Open speaker roles:** the VPE enters speech details at assign time (reuse the existing
   speaker-detail fields), since `claimSlot` requires `speakerDetails` for speaker roles.
3. **Landing status:** a direct assignment lands as `claimed` (VPE can still `confirm` separately).
4. **Reassign resets confirmation:** `reassignSlot` will reset status to `claimed` when it swaps
   the assignee (see Backend). Applies to the shared "take over" path too — arguably more correct
   (a new holder hasn't been confirmed).
5. **Picker:** searchable `Command` list in a `Popover`.

## Architecture

### Backend

**`src/server/meetings.ts` — `loadMeetingDetail`**
- Add `roster: { id: string; name: string }[]` to the return value: **active** members of the
  meeting's club, ordered by name.
- Populate it **only when `canManage` is true**; otherwise return `[]`. This keeps the full member
  list out of the public/unauthenticated `getMeeting` payload (today only assigned names are
  exposed to anon callers; we don't widen that).

**`src/server/slots.ts` — `reassignSlot`**
- In the update, also set `status: "claimed"` alongside `assignedMemberId`, so a reassigned slot
  is never left `confirmed` under a member who hasn't been confirmed.
- This path is shared with the self-serve "take over" flow; the reset applies there too.
- **Risk:** an existing test may assert reassign preserves status — check and update
  `meeting-manage.integration.test.ts` / any slots test if so.
- No change to `claimSlot` — it already sets `status: "claimed"` and accepts an arbitrary
  `memberId` + `speakerDetails`.

### Frontend

**New component: `src/components/club/assign-slot-sheet.tsx`**
- Props: `slot`, `roster: { id; name }[]`, `actorMemberId`, `roleCounts`, `onOpenChange`,
  `onAssigned`.
- Renders a searchable member picker (shadcn `Command` inside a `Popover`).
- When `slot.isSpeakerRole` and the slot is currently **open**, also render the speech-detail
  fields (speech title required; project path/name/level and min/max minutes optional) — mirroring
  the existing speaker claim sheet.
- On submit, dispatches via the pure resolver (below):
  - open + non-speaker → `claimSlot({ slotId, memberId: chosen, actorMemberId })`
  - open + speaker → `claimSlot({ slotId, memberId: chosen, actorMemberId, speakerDetails })`
  - filled (any) → `reassignSlot({ slotId, memberId: chosen, actorMemberId })`
- Lives in its own file to avoid growing the already-large route module.

**Route wiring: `src/routes/_authed/meetings.$id.tsx`**
- Read `roster` from the loader data.
- Gated on `canManage`, add:
  - an **"Assign…"** control on open slots (next to the existing self "Claim"),
  - a **"Reassign…"** control on filled slots.
- Both open `AssignSlotSheet` for the target slot. On success, `router.invalidate()`.

### Testable seam

**`resolveAssignAction(slot)`** — pure helper in `src/lib/agenda.ts` (alongside `buildRoleCounts` /
`slotLabel`, tested in `src/lib/agenda.test.ts`) returning:
```ts
{ kind: "claim" | "reassign"; requiresSpeakerDetails: boolean }
```
- open + non-speaker → `{ kind: "claim", requiresSpeakerDetails: false }`
- open + speaker → `{ kind: "claim", requiresSpeakerDetails: true }`
- filled → `{ kind: "reassign", requiresSpeakerDetails: false }`

## Testing

- **Unit:** `resolveAssignAction` covers the three slot shapes.
- **Integration** (`meeting-manage.integration.test.ts` or a sibling): VPE assigns an open slot →
  status `claimed`, assignee set, activity `claim` logged with `detail.memberId`. Reassign a filled
  slot → assignee changed, status `claimed`, activity `reassign` logged with `fromMemberId`/`memberId`.
- **Roster gating:** assert `loadMeetingDetail` returns `roster: []` for a non-managing caller and a
  populated roster for a manager (extend `public-reads.integration.test.ts` or the meeting-manage test).
- `bun run check` (Biome) and `bun run build` (type check) clean.

## Activity log

No new logging code: `claimSlot` logs `claim`, `reassignSlot` logs `reassign` (with
`fromMemberId` + `memberId`), actor = the acting VPE.
