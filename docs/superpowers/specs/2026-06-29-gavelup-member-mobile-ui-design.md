# GavelUp Member Mobile UI — Design

- **Date:** 2026-06-29
- **Status:** Approved (brainstorm + visual companion); ready for implementation plan
- **Issue:** #33 (member mobile self-serve flow)
- **Depends on:** **Phase B de-auth server layer** (`docs/superpowers/plans/2026-06-29-gavelup-deauth-cutover.md`). This surface needs public reads + member-keyed writes. **This spec also decides the member-identity mechanism Phase B was waiting on** (see §Identity), un-gating Phase B's condition #2.
- **Builds on:** the self-serve MVP spec (`…-gavelup-self-serve-mvp-design.md` §1, §3) and the GavelUp design system (shadcn primitives synced in #30, `src/components/club/*`). Phase A (roster re-key) is already merged.

## North star

A **public, mobile-first** surface where a club member opens a link (or the app root), identifies by **picking their name** (no login), and claims/releases roles — seeing each role's **responsibilities** before committing. This is a *separate surface* from the authed VPE desktop workspace (`_authed/*`), which is untouched.

## Entry & routing (hybrid — decision C)

A new **public** route tree (NOT under `_authed`):
- `/club/$clubId` — the member **home**.
- `/club/$clubId/meeting/$meetingId` — the **meeting / claim** view. **This is the URL the VPE shares** (WhatsApp).

Both converge on the meeting view. A shared link deep-links straight to the meeting; opening the root shows the home. Identity (pick-your-name) happens once and is remembered, so neither path nags returning members.

## Identity (decides Phase B's mechanism)

- **Self-asserted, trust-based, no auth.** The member picks their name from the club roster; we store `{ clubId → memberId }` in **`localStorage`** (key e.g. `gavelup:member:<clubId>`).
- A small client hook **`useCurrentMember(clubId)`** reads it; a `<RequireMember>` gate renders the **pick-name screen** when it's absent (or when the user taps "not you?").
- Every write passes that `memberId` as **`memberId`/`actorMemberId`** — exactly the Phase A/B server contract. *So this localStorage-memberId-in-payload IS the identity mechanism Phase B was gated on.*
- **Pick-name screen:** searchable list from `listMembers(clubId)` + an "I'm new — add me" that calls `addMember` and then remembers the new id. "not you?" clears the stored id and re-opens the picker (trust-based switch).
- **Stale id:** if the stored `memberId` no longer resolves (member removed/merged), treat as "not picked" and re-prompt.

## Screens

### 1. Pick-name gate (`<RequireMember>`)
Shown when no remembered member. Searchable roster (`listMembers`), avatars (reuse `src/lib/avatar.ts` / `src/components/club/member-avatar.tsx`), self-add. On select/add → store id → continue to the intended route.

### 2. Home — `/club/$clubId`
- Header: "Hi {name}", club name, a "not you?" affordance.
- **Your upcoming roles** — from a **Phase B** public `listMemberCommitments(memberId)` (takes an explicit member id; Phase A kept the authed `listMyCommitments` that resolves the session user — the member surface needs the explicit-memberId variant): each claimed slot with meeting date, role, and a Release.
- **Meetings with open roles** — from `listUpcomingMeetings(clubId)` (public): upcoming meetings with an open-count badge → tap to the meeting view.
- **Browse all meetings** link.

### 3. Meeting / claim — `/club/$clubId/meeting/$meetingId` (layout A)
- Header: theme, date/time (club tz), location; a meeting-level **"I can't make this one"** toggle (`setAvailability`/`clearAvailability`).
- Roles **grouped by category** (Leadership / Speakers / Evaluators / Functionaries), each a compact row: name (numbered when repeated, e.g. "Speaker 2" — reuse `src/lib/agenda.ts` `slotLabel`/`buildRoleCounts`), status pill (open / you / filled-with-name), and the evaluator→speaker link line where present.
- **Tap an open role → bottom Sheet** (`src/components/ui/sheet`): full **responsibilities** (`roleDefinitions.description`) + a **Claim** button. Speaker roles show the **speech-details form** first (reuse the field set already in `src/routes/_authed/meetings.$id.tsx`'s `ClaimSpeakerSheet`: title required, Pathways path/project/level, min/max minutes).
- **Your** rows show a **Release**. **Sheet-parity:** the claim sheet footer reads "claiming as {name} · not you?" — tapping switches the acting member; claiming/reassigning a slot held by someone else triggers a **soft confirm** ("This is Mahbuba's slot — take it over?"). All writes go through `claimSlot`/`releaseSlot`/`reassignSlot` with `memberId`/`actorMemberId`.
- Optimistic UI + `router.invalidate()` after writes (matching the existing claim handlers' toast/`invalidate` pattern).

## Architecture / components

- **New public route group** with its own minimal **mobile shell** (header + safe-area + Toaster), separate from `_authed.tsx`'s desktop workspace shell. Routes are public (no `beforeLoad` auth redirect).
- **`useCurrentMember(clubId)`** + **`<RequireMember>`** (client) — identity store/gate.
- **Screen components** under `src/routes/club.$clubId.*` (or a `(public)` group): home, meeting; plus presentational pieces (role row, claim sheet) — reuse `src/components/club/*` (status pill, member avatar) and `src/components/ui/*`.
- **Server fns consumed (all Phase B, public):** `listMembers`, `addMember`, `listUpcomingMeetings`, `getMeeting`, `listMemberCommitments`, `claimSlot`/`releaseSlot`/`reassignSlot`, `setAvailability`/`clearAvailability`. Each must be callable without a session.

## Error handling / edge cases

- No remembered member → pick-name gate (never a hard error).
- Stale/removed member id → re-prompt.
- Claim race (someone took it) → the server's conditional-update error surfaces as a toast; refresh shows the new state.
- Speaker claim without details → blocked client-side (form) + server-side (Phase A guard).
- Sends/writes are trust-based; soft-confirm prevents accidental takeovers; the activity log (already wired) records who did what.

## Testing

- **Pure/client:** unit-test `useCurrentMember` (read/write/clear, stale handling) and `slotLabel` reuse. Component tests (Testing Library) for the pick-name gate (search/self-add), the meeting view (group/claim/release/Not-Available), and the soft-confirm.
- **Server:** covered by Phase B's integration tests (public reads + member-keyed writes).
- **Manual:** open `/club/$clubId/meeting/$meetingId` in a fresh browser (no session) → pick name → claim → release; confirm the VPE workspace still shows the change.

## Out of scope (deferred)
- Anything VPE-only (overview grid, roster merge/dedupe, activity-log *view*) — that's the authed workspace.
- Multi-club switching UI (#10); push/PWA/offline; per-member notification prefs.
- "Claim for someone else" beyond the trust-based "not you?" switch (no separate member-picker-per-slot).

## Open questions / risks
- **localStorage identity is per-device** — a member on a new phone re-picks (acceptable; no account by design).
- **Impersonation** — anyone can pick any name (same trust as the sheet); the activity log is the mitigation.
- **First-visit via shared link** — if the member has never picked a name, the meeting route shows the pick-name gate first, then returns to the meeting (preserve the intended URL).
- **Phase B must land first** — without the public/de-authed server fns, this surface can't function; sequence accordingly.
