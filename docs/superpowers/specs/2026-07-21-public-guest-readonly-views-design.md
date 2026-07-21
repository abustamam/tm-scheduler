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
time they try to *act* (claim an open role, decline a meeting), they are asked
"who are you?" inline — one tap → identify → the action they intended completes.
Both public views also surface a compact guest-resources strip and an always-
present "identify" control.

Non-goals:
- No change to real authentication (Better-Auth magic-link) or the shell-wrap
  path for signed-in members (#317).
- No new routes. We reuse `/club/:clubId/` and `/club/:clubId/meeting/:meetingId`.
- No server/DB changes. The claim/release/reassign/availability server fns are
  already member-keyed and session-free; only the *timing* of collecting the
  member id changes on the client. (One exception under consideration: an
  `addMember` guardrail — see "Deferred / follow-ups".)

## Decisions (settled during brainstorming + design review)

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
4. **Resources = a compact "New to Toastmasters?" strip**, shown to everyone
   (including the signed-in shell view), on both surfaces and in both grid
   orientations, linking `what-to-expect`, `guest-faq`, `meeting-roles`.
5. **Not search-indexable.** The public club subtree is meant for people you
   share the link with, not independent discovery. All `/club/:clubId*` routes
   emit `robots: noindex, nofollow`. `/resources` stays indexable.
6. **No booting via the honor system.** The name-pick path can claim *open*
   roles but cannot **take over** a role someone already holds. Take-over
   (`reassignSlot`) becomes a **signed-in-only** affordance (the #317 shell
   path). This is a deliberate tightening of ADR-0010's self-serve take-over.
7. **Explicit "identify" control.** An always-present "Viewing as" bar lets any
   visitor (notably the TMOD/Grammarian, who hold slots and so have nothing to
   *claim*) establish identity without needing a claim action.

## Approach

**"Prospective viewer" + a shared `requireIdentity()` seam.** The alternatives
(a two-step "participate" CTA gate; a provisional fake identity) were rejected:
the CTA gate isn't the chosen one-tap interaction, and a fake id would pollute
"(you)" markers and per-slot mine/not-mine logic and risk leaking a bogus id
into a server call.

### 1. Remove the hard gate + add noindex

`club.$clubId.tsx`: replace the anonymous-path `<RequireMember>{Outlet}</RequireMember>`
(`:109-111`) with `<IdentityGateProvider>{Outlet}</IdentityGateProvider>`. The
lightweight header (BrandMark, club name, theme toggle, "Sign in" bridge) is
unchanged. The shell (signed-in member) path (`:76-86`) is unchanged. The view
now always renders.

Add `head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] })`
to `club.$clubId.tsx` (covers the index + meeting agenda, which nest under it)
and to each underscore-escaped public club route that does *not* nest under that
layout: `club.$clubId_.guest-book.tsx`,
`club.$clubId_.meeting.$meetingId.present.tsx`,
`club.$clubId_.meeting.$meetingId.print.tsx`.

### 2. `IdentityGateProvider` (new — `src/components/club/identity-gate.tsx`)

A React context provider rendered around the club `<Outlet/>`. Responsibilities:

- Owns a name-pick **`Dialog`**. Its body is the existing `PickNameScreen`
  content (roster search + "I'm new — add me"), extracted into a reusable
  `PickNameForm`. The full-page `RequireMember`/`PickNameScreen` is retired
  (`RequireMember` has exactly one caller).
- Exposes `useRequireIdentity()` → `{ member, requireIdentity, promptIdentity }`:
  - `member`: the current effective member (or `null`).
  - `requireIdentity(): Promise<StoredMember | null>` — if a member is stored,
    resolves immediately. Otherwise opens the dialog and resolves with the
    newly-picked member (persisted through the shared `useCurrentMember` store,
    so every subscriber updates). **Dialog dismissal resolves `null`** — callers
    treat `null` as "abort," firing nothing (no toast, no mutation). This avoids
    unhandled promise rejections.
  - `promptIdentity()` — force-opens the dialog even when an identity exists, for
    the "not you?" / "I'm a member" switch flow. On pick, replaces identity; on
    dismiss, the previous identity is retained (never stranded read-only).
  - **Single-flight:** concurrent `requireIdentity()` calls while the dialog is
    open share one pending promise and all resolve with the same pick.
- On the shell (signed-in) path the provider is a pass-through: `member` is the
  session member and `requireIdentity()` resolves immediately (dialog never
  opens), so consumers use one uniform hook regardless of surface.

Identity is read/written through the existing `useCurrentMember` shared external
store — the provider is the only new writer of a name-pick, so there is a single
source of truth and no divergence from `useEffectiveMember` reads in the pages.

### 3. Prospective affordances + take-over guardrail (shared components)

Today every "offer" capability is gated on having an identity, which is why the
view can render but the claim button can't.

- **`meetingViewer` (`src/lib/meeting-viewer.ts`)** gains two inputs:
  `isProspective` (no identity yet) and `isSignedIn` (the real-auth shell path).
  Capability rules:
  - `canClaim`, `canToggleAvailability` — granted for a prospective visitor when
    `isEditableWindow` (they tap → identify → act). Also granted to any identity.
  - `canTakeOver` — **`isSignedIn` only.** Neither a prospective visitor nor an
    anonymous name-pick identity may boot a held role (decision #6). This is the
    one capability that no longer follows `hasIdentity`.
  - `canReleaseOwn`, `canEditOwnSpeech` — granted to **any established identity**
    (anon name-pick *or* signed-in) that holds the slot; releasing your *own*
    role is not booting, so it stays on the honor-system path (unchanged). A
    prospective visitor holds nothing, so these stay off until identity exists.
  - Role-scoped `canAssign` / `canManageSpeakers` / `canEditMeetingMeta` /
    `canEditWod` — unchanged; false for a brand-new guest, and appear normally
    once someone identifies *as* the TMOD/Grammarian (via `deriveMeetingRoleFlags`).
- **`MeetingAgenda` (`src/components/agenda/meeting-agenda.tsx`)** renders the
  offered controls when the viewer grants them, even with `currentMemberId ===
  null`. With a null id, open slots → "Claim" (`canClaim`); filled slots show
  **no** take-over for the anon/prospective path (guardrail), only for signed-in.
  The action callbacks resolve identity before mutating.
- **`GridCell` (`src/components/club/grid-cell.tsx`) / `SeasonGrid`.** Today
  `interactive = !!currentMemberId && !!cell.slotId` (`grid-cell.tsx:64`) hides
  "Claim" from guests. Add a prospective path so an *open* cell shows "Claim"
  with no identity; its `onClaim` runs `requireIdentity()` then claims. The grid
  already prevents claiming an already-assigned cell (only `cell.kind === "open"`
  is claimable — others are read-only/greyed), so the take-over guardrail needs
  no extra grid work. The `SeasonGrid` handlers (`claim`/`release`/availability)
  drop their `if (!currentMemberId) return` early-returns in favor of the seam.

The action wiring pattern everywhere becomes:

```ts
async function claim(slotId: string) {
  const me = await requireIdentity();   // stored id, or opens dialog
  if (!me) return;                      // dismissed → abort
  await claimSlot({ data: { slotId, memberId: me.id, actorMemberId: me.id } });
  // …toast + refetch
}
```

In `club.$clubId.meeting.$meetingId.tsx` the existing
`if (!myId) throw new Error("Pick your name first.")` guards in the `actions`
object (`:233-267`) are replaced by the `requireIdentity()`-first pattern; the
`viewer` is built with `isProspective: myId === null` and `isSignedIn:
session !== null`.

### 4. "Viewing as" bar (evolve `SigningUpAs` → `src/components/club/viewing-as.tsx`)

Promote the identity line to an always-present control on both surfaces (decision
#7), replacing the render-nothing-when-anonymous `SigningUpAs`:

- **Guest state (no identity):** a low-key chip — *"Viewing as guest · I'm a
  member →"* — that calls `promptIdentity()`. This is the discoverable entry
  point for a TMOD/Grammarian (who hold slots and have nothing to claim) and for
  a signed-in-non-member guest (decision, see below).
- **Identified state:** *"Signing up as {name} · not you?"* where "not you?"
  calls `promptIdentity()` to *switch* (dismiss retains current identity).

**Signed-in non-member:** a user authenticated via magic-link but not a member of
the club they're viewing falls to the anonymous path (`publicShellDecision`) and
is treated as a **guest of that club** — read-only, with the same optional
name-pick to participate. No special handling beyond the guest state above.

### 5. Guest-resources strip (new — `src/components/club/guest-resources.tsx`)

A compact "New to Toastmasters?" strip linking `what-to-expect`, `guest-faq`,
`meeting-roles` (slugs from `src/data/resources.ts`). Shown to everyone
(including the signed-in shell view — decision #4/#10) on:

- the season grid page — replacing the ad-hoc single link at
  `club.$clubId.index.tsx:105-111`. It is page-level (outside the grid), so it
  shows in both Roles×Meetings and Members×Meetings orientations (decision #9).
- the single-meeting agenda — in the header, near the share/print actions.

Generic content, no coupling to club/meeting data (matches the resources
registry's intentional `#/db` decoupling).

### 6. Personalized-section degradation

- **"Your upcoming roles"** (`club.$clubId.index.tsx:146-226`) shows a perpetual
  "Loading your roles…" when `!member` (`:148-158`) because today a member is
  guaranteed. For a guest it becomes a friendly empty/CTA state ("Claim a role in
  the sheet above to see it here").
- **`SigningUpAs`** is replaced by the "Viewing as" bar (§4).

### 7. Client-render / hydration decision

Keep the SSR read-only render — the agenda/grid render server-side with no
identity (fast first paint, usable preview when shared). A *returning* member
(name in localStorage, unreadable on the server) gets a brief prospective→
identified swap after mount (server renders "Claim"; client with a stored name
re-renders to their "(you)" markers / release controls). This flash is accepted
as minor — we do **not** gate the whole page behind a `mounted` skeleton (that
would defeat the shareable read-only preview). The old `RequireMember` `mounted`
skeleton is retired with it.

**Unmount-after-resolve** (user navigates away between pick and resolve) is
accepted as low-risk: the resolved `me.id` drives the mutation, which completes
server-side (a benign write the user did intend by tapping), and UI side effects
on an unmounted component are no-ops. No extra machinery.

## Testing

- **PII boundary (unchanged):** `public-meeting-contact.guard.test.ts` still
  enforces `getPublicMeeting`-only on public routes; boundary is unchanged.
- **`meetingViewer` matrix:** unit-test the capability sets across
  {prospective, anon name-pick, signed-in} × {editable, locked/past}. Key
  assertions: prospective + editable grants exactly `canClaim` +
  `canToggleAvailability`; **`canTakeOver` is granted only when `isSignedIn`**;
  locked/past grants no offer capabilities; an identified TMOD/Grammarian is
  unaffected.
- **Interaction:** component tests that a no-identity visitor sees a read-only
  agenda + grid *with* claim affordances (and **no** take-over on filled slots);
  tapping "Claim" opens the dialog; picking a name fires the intended claim and
  persists identity; **dismissing the dialog fires nothing** (null-abort);
  "Viewing as guest · I'm a member" and "not you?" both open the dialog.
- **noindex:** assert the robots meta is present on the club routes (and absent
  on `/resources`).
- **Resource strip:** renders the three links on both surfaces / both orientations.

## Deferred / follow-ups

- **`addMember` rate-limiting (pre-existing, not opened by this change).**
  `addMember` (`members.ts:50`) is public and unthrottled — anyone can spawn
  `person`/`member` rows. This is already reachable via today's name-pick screen,
  so the inversion doesn't widen it (it likely reduces call volume). Proposed as
  a **separate hardening issue** (e.g. per-IP/per-club self-add cap), not a
  blocker for this feature. Flag for the user to green-light as follow-up.
- **Impersonation via name-pick is a pre-existing honor-system property.** A
  visitor can pick anyone's name and then release *that person's* own slots (or
  claim an open slot as them). Decision #6 closes the worst case (booting a *held*
  role now needs real sign-in), but release-as-someone-else via impersonation is
  unchanged by this spec and out of scope. Note for future hardening if abuse
  appears.

## Files touched (anticipated)

- `src/routes/club.$clubId.tsx` — swap `RequireMember` → `IdentityGateProvider`; add robots noindex.
- `src/routes/club.$clubId_.guest-book.tsx`, `…present.tsx`, `…print.tsx` — add robots noindex.
- `src/components/club/identity-gate.tsx` — **new** provider + `useRequireIdentity` + dialog (single-flight, null-abort, `promptIdentity`).
- `src/components/club/pick-name-form.tsx` — **new** (extracted from `PickNameScreen`).
- `src/components/club/require-member.tsx` — retired.
- `src/lib/meeting-viewer.ts` — `isProspective` + `isSignedIn` inputs; `canTakeOver = isSignedIn`.
- `src/components/agenda/meeting-agenda.tsx` — render offered controls with null id; suppress take-over off the signed-in path.
- `src/components/club/grid-cell.tsx` + `src/components/club/season-grid.tsx` — prospective claim path via the seam.
- `src/routes/club.$clubId.meeting.$meetingId.tsx` — `requireIdentity()`-first actions; prospective + signed-in viewer inputs.
- `src/routes/club.$clubId.index.tsx` — resource strip + "Your upcoming roles" guest empty state.
- `src/components/club/viewing-as.tsx` — **new**, replaces `signing-up-as.tsx` (always-present, guest + switch states).
- `src/components/club/guest-resources.tsx` — **new** strip.
- Tests as above.
</content>
