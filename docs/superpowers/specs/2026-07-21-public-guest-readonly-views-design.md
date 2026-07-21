# Public club views: read-only by default, identity-gated participation

**Date:** 2026-07-21
**Status:** Approved design — ready for implementation plan
**Related:** #198 (interactive sign-up sheet), #220 (`SigningUpAs`), #266 (claim account), #310/#321 (public `/resources`), #317 (shell-wrap for signed-in members), ADR-0010 (self-serve capabilities)

## Problem

The public `/club/:clubId` subtree (the season-grid sign-up sheet and the
single-meeting agenda) is wrapped in a hard `RequireMember` gate
(`club.$clubId.tsx:109`). An anonymous visitor sees a **"Who are you? Pick your
name to continue"** screen *before* they can see anything. That makes the link
unshareable to the audience that matters most — potential guests, prospective
members, or anyone you send a meeting link to. It also forces every casual
viewer (including existing members who just want to glance) to create/pick an
identity, which spawns spurious `member` rows.

Separately, these public views don't surface the guest-facing resources that
already exist at `/resources` (`what-to-expect`, `guest-faq`, `meeting-roles`).
The meeting agenda links to none of them; the season grid links only to a single
ad-hoc `what-to-expect` link (`club.$clubId.index.tsx:105`).

## Goal

Invert the model: **anyone can view; identity is required only to participate.**
A guest can read the season grid and any meeting agenda with no gate. The first
time they try to *act* (claim a role, take over a slot, decline a meeting), they
are asked "who are you?" inline — one tap → identify → the action they intended
completes. Both public views also surface a compact guest-resources strip.

Non-goals:
- No change to real authentication (Better-Auth magic-link) or the shell-wrap
  path for signed-in members (#317).
- No new routes. We reuse `/club/:clubId/` and `/club/:clubId/meeting/:meetingId`.
- No server/DB changes. The claim/release/reassign/availability server fns are
  already member-keyed and session-free; only the *timing* of collecting the
  member id changes on the client.

## Decisions (settled during brainstorming)

1. **Participation gate = the existing lightweight name-pick** (localStorage
   honor system via `useCurrentMember`), *not* real magic-link auth. Same trust
   model as today; only relocated from a view gate to a participate gate.
2. **Scope = both public surfaces** — the season grid (`/club/:clubId/`) and the
   single-meeting agenda (`/club/:clubId/meeting/:meetingId`). The gate lives at
   the layout, so it inverts once for both.
3. **Interaction = inline prompt on the action.** The claim affordance stays
   visible; tapping it (with no stored identity) opens the name-pick in a
   **dialog**, and on pick the intended action auto-completes. Identity then
   persists for the rest of the session (unchanged `useCurrentMember` store).
4. **Resources = a compact "New to Toastmasters?" strip**, shown to everyone, on
   both surfaces, linking `what-to-expect`, `guest-faq`, `meeting-roles`.

## Approach

**"Prospective viewer" + a shared `requireIdentity()` seam.** The alternatives
(a two-step "participate" CTA gate; a provisional fake identity) were rejected:
the CTA gate isn't the chosen one-tap interaction, and a fake id would pollute
"(you)" markers and per-slot mine/not-mine logic and risk leaking a bogus id
into a server call.

### 1. Remove the hard gate

`club.$clubId.tsx`: replace the anonymous-path `<RequireMember>{Outlet}</RequireMember>`
(`:109-111`) with `<IdentityGateProvider>{Outlet}</IdentityGateProvider>`. The
lightweight header (BrandMark, club name, theme toggle, "Sign in" bridge) is
unchanged. The shell (signed-in member) path (`:76-86`) is unchanged. The view
now always renders.

### 2. `IdentityGateProvider` (new — `src/components/club/identity-gate.tsx`)

A React context provider rendered around the club `<Outlet/>`. Responsibilities:

- Owns a name-pick **`Dialog`**. Its body is the existing `PickNameScreen`
  content (roster search + "I'm new — add me"), extracted into a reusable
  `PickNameForm`. The full-page `RequireMember`/`PickNameScreen` is retired
  (`RequireMember` has exactly one caller).
- Exposes `useRequireIdentity()` → `{ member, requireIdentity }`:
  - `member`: the current effective member (or `null`).
  - `requireIdentity(): Promise<StoredMember>` — if a member is stored, resolves
    immediately. Otherwise opens the dialog, holds the resolver, and resolves
    with the newly-picked member (persisted through the shared `useCurrentMember`
    store, so every subscriber — grid, agenda, `SigningUpAs` — updates). Dialog
    dismissal rejects/aborts; the caller drops the pending action silently.
- On the shell (signed-in) path the provider is a pass-through: `member` is the
  session member and `requireIdentity()` resolves immediately (dialog never
  opens), so consumers use one uniform hook regardless of surface.

Identity is read/written through the existing `useCurrentMember` shared external
store — the provider is the only new writer of a name-pick, so there is a single
source of truth and no divergence from `useEffectiveMember` reads in the pages.

### 3. Prospective affordances (shared components)

The reason the view can render but the claim button can't (today) is that every
"offer" capability is gated on having an identity.

- **`meetingViewer` (`src/lib/meeting-viewer.ts`)** gains an `isProspective`
  input. When there is no identity but `isEditableWindow` is true, it grants the
  *offer* capabilities — `canClaim`, `canTakeOver`, `canToggleAvailability` —
  even though `currentMemberId` is `null`. It does **not** grant `canReleaseOwn`
  or `canEditOwnSpeech` (a guest holds no slot to release), nor the role-scoped
  `canAssign`/`canManageSpeakers`/`canEditMeetingMeta`/`canEditWod` (a brand-new
  guest is not the TMOD/Grammarian). When a guest identifies *as* someone who is
  the TMOD/Grammarian, the page re-renders with a real id and those affordances
  appear through the normal `deriveMeetingRoleFlags` path — no special-casing.
- **`MeetingAgenda` (`src/components/agenda/meeting-agenda.tsx`)** renders the
  offered controls when the viewer grants them, even with `currentMemberId ===
  null`. The per-slot classification with a null id is coherent: every open slot
  → "Claim" (`canClaim`), every filled slot → not-mine → "Take over"
  (`canTakeOver`). The action callbacks resolve identity before mutating.
- **`GridCell` (`src/components/club/grid-cell.tsx`) / `SeasonGrid`.** Today
  `interactive = !!currentMemberId && !!cell.slotId` (`grid-cell.tsx:64`) hides
  "Claim" from guests. Add a prospective path so an open cell shows "Claim" with
  no identity; its `onClaim` runs `requireIdentity()` then claims. The action
  handlers in `SeasonGrid` (`claim`/`release`/availability) drop their
  `if (!currentMemberId) return` early-return in favor of resolving the id via
  the seam.

The action wiring pattern everywhere becomes:

```ts
async function claim(slotId: string) {
  const me = await requireIdentity();   // resolves stored id, or opens dialog
  await claimSlot({ data: { slotId, memberId: me.id, actorMemberId: me.id } });
  // …toast + refetch
}
```

In `club.$clubId.meeting.$meetingId.tsx` the existing
`if (!myId) throw new Error("Pick your name first.")` guards in the `actions`
object (`:233-267`) are replaced by the `requireIdentity()`-first pattern, and
the `viewer` is built with `isProspective: myId === null`.

### 4. Guest-resources strip (new — `src/components/club/guest-resources.tsx`)

A compact "New to Toastmasters?" strip linking to `what-to-expect`, `guest-faq`,
and `meeting-roles` (slugs from `src/data/resources.ts`). Shown to everyone on:

- the season grid — replacing the ad-hoc single link at
  `club.$clubId.index.tsx:105-111`;
- the single-meeting agenda — in the header, near the share/print actions.

Generic content, no coupling to club/meeting data (matches how the resources
registry is intentionally decoupled from `#/db`).

### 5. Personalized-section degradation

- **"Your upcoming roles"** (`club.$clubId.index.tsx:146-226`) shows a perpetual
  "Loading your roles…" when `!member` (`:148-158`) because today a member is
  guaranteed. For a guest it becomes a friendly empty/CTA state ("Claim a role in
  the sheet above to see it here").
- **`SigningUpAs`** (`src/components/club/signing-up-as.tsx`) already renders
  nothing without identity (`:17`) — correct as-is. The "Signing up as … · not
  you?" line appears once the guest identifies via a claim. Its doc comment's
  reference to the `RequireMember` gate re-render is updated (clearing identity
  now returns to prospective/read-only mode, not the full-page gate).

## Testing

- **PII boundary (unchanged):** `public-meeting-contact.guard.test.ts` still
  enforces `getPublicMeeting`-only on public routes; boundary is unchanged.
- **`meetingViewer` matrix:** unit-test the prospective capability set — no
  identity + editable window grants exactly `canClaim`/`canTakeOver`/
  `canToggleAvailability` and nothing else; a locked/past window grants none;
  an identified TMOD/Grammarian is unaffected.
- **Interaction:** component tests that a no-identity visitor sees a read-only
  agenda + grid *with* claim affordances; tapping "Claim" opens the dialog;
  picking a name fires the intended claim and persists identity; dismissing the
  dialog fires nothing.
- **Resource strip:** renders the three links on both surfaces.

## Files touched (anticipated)

- `src/routes/club.$clubId.tsx` — swap `RequireMember` → `IdentityGateProvider`.
- `src/components/club/identity-gate.tsx` — **new** provider + `useRequireIdentity` + dialog.
- `src/components/club/pick-name-form.tsx` — **new** (extracted from `PickNameScreen`).
- `src/components/club/require-member.tsx` — retired (removed once callers migrate).
- `src/lib/meeting-viewer.ts` — `isProspective` input + offer-capability logic.
- `src/components/agenda/meeting-agenda.tsx` — render offered controls with null id.
- `src/components/club/grid-cell.tsx` + `src/components/club/season-grid.tsx` — prospective claim path.
- `src/routes/club.$clubId.meeting.$meetingId.tsx` — `requireIdentity()`-first actions, prospective viewer.
- `src/routes/club.$clubId.index.tsx` — resource strip + "Your upcoming roles" guest empty state.
- `src/components/club/guest-resources.tsx` — **new** strip.
- `src/components/club/signing-up-as.tsx` — doc comment update.
- Tests as above.
</content>
</invoke>
