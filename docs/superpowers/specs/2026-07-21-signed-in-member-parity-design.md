# Signed-in member parity: unified meeting viewer + shell-wrapped public routes

**Issues:** closes #302 (Grammarian WOD editing in the authed app) and #317 (signed-in users keep the app shell on public routes).
**Related:** #198 / #145 (route/component convergence, already shipped), #284 (member-contact sign-in gate), #310 (public resources page, in flight), #320 (admin "preview as member", spun out of this design).
**Date:** 2026-07-21

## Goal

A signed-in member gets a first-class, in-shell experience with full self-serve parity everywhere — no sign-in re-prompt on public routes, no leaving the app to do their own role's job — while anonymous visitors keep today's exact no-auth experience.

## Background — what already exists

The expensive convergence is done. #145 produced a single shared `<MeetingAgenda>` component (`src/components/agenda/meeting-agenda`) that **both** the authed meeting route (`src/routes/_authed/meetings.$id.tsx`) and the public meeting route (`src/routes/club.$clubId.meeting.$meetingId.tsx`) render. The component is identity-agnostic: it consumes one `MeetingViewer` object (`src/lib/meeting-viewer.ts`) and never reads a session or the localStorage identity directly.

The surfaces diverge in only three places:

1. **The viewer adapter.** `sessionViewer` (authed) grants management if admin and turns the self-serve caps (`canToggleAvailability` / `canTakeOver` / `canEditOwnSpeech`) **off**. `selfAssertedViewer` (public) turns them **on** and grants the TMOD `canAssign` / `canManageSpeakers`. Two adapters that must be kept in sync — that drift is the bug behind #302.
2. **The chrome.** Authed routes render the full sidebar (`_authed.tsx` → `WorkspaceLayout` → `SidebarInner`). Public routes render a lightweight header (`club.$clubId.tsx` → `ClubShell`: brand mark + club name + "Sign in" link) and gate on a name-pick (`RequireMember`).
3. **Route-level edit affordances.** Two dialogs, defined inline in the route files:
   - **"Edit meeting"** — full meta dialog (theme / location / word-of-the-day / notes / reschedule). Shown to `canManage` (admin) on the authed route; to `isTmod` on the public route (`EditMeetingMetaDialog`, self-assert, reschedule hidden).
   - **"Edit Word of the Day"** — focused dialog for the pure grammarian with no broader edit path (`isGrammarian && !isTmod && !over`, public route only, `WordOfTheDayDialog`).

**Data loaders** already exist and are session-aware where it matters (`src/server/meetings.ts`):
- `getMeeting` — session-**optional**; resolves `canManage` from the session when present (admin → management; anon/non-admin → `canManage:false`). Contact/roster PII is loaded **only when `canManage`** (admin-gated, not sign-in-gated).
- `getPublicMeeting` — **deliberately** forces `canManage:false` regardless of session, so today an admin who opens a public share link sees the plain member view.

**Server authz** already supports every path (`src/server/meeting-authz-logic.ts`):
- `updateMeeting` → `requireMeetingAgendaEditor`, grants `via: "admin" | "tmod-self-assert"` (TMOD self-assert is meta-only; reschedule is admin-only, rejected server-side for TMOD).
- `updateWordOfTheDay` → `resolveWordOfTheDayAuthz`, grants `via: "admin" | "tmod-self-assert" | "grammarian-self-assert"`.

So the convergence is small and localized: unify the adapter, lift the two dialogs into the shared component, select the right loader, and share the shell — no schema change, no new server capability, URLs stable.

## Design decisions (resolved)

1. **Option A — enrich, keep two surfaces.** Do not retire the authed routes or reshuffle IA. Converge onto shared building blocks so "public vs authed" becomes about entry/URL, not data, caps, or chrome. (Option B — one surface, retire authed member routes — rejected as a large reshuffle for marginal benefit now that the component is shared.)
2. **Full capability parity via one unified viewer.** A signed-in member gets exactly what the public self-serve surface grants for their role, acting as their verified self — including a signed-in TMOD getting the run-the-meeting powers a name-picked TMOD already has. Implemented by collapsing the two adapters into one, so parity holds by construction.
3. **Shell-wrap in place** (not redirect-to-twin). A signed-in user landing on a public URL keeps the URL and renders inside the app shell, identity from the session, name-pick skipped. Uniform, URL-stable, share links keep working.
4. **Shell-wrap is gated on membership of the viewed club.** A signed-in user viewing a club they do **not** belong to falls back to today's anonymous public experience. Contact PII stays **admin-gated** on the meeting view (not expanded to non-admin members).
5. **Accept the admin-on-shared-link reversal.** A signed-in admin opening the public share link now loads via `getMeeting` and gets full management + the shell (reversing `getPublicMeeting`'s "admin sees member view"). The old preview behavior is re-provided explicitly by #320 ("Preview as member"), not by the public URL.
6. **Lift both edit dialogs into the shared component,** each a shared dialog taking `actorMemberId` + `selfMemberId`; the reschedule field inside "Edit meeting" stays admin-only.
7. **Follow-a-link switches the active club.** A member opening a public link for a club they belong to that isn't their active club makes it active (same as the club switcher), so shell, nav, and identity resolve coherently.

## Architecture

### 1. Unified viewer (`src/lib/meeting-viewer.ts`)

Replace `sessionViewer` + `selfAssertedViewer` with one adapter:

```ts
meetingViewer({ currentMemberId, canManage, isTmod, isGrammarian })
```

Both surfaces call it — the public route passes `canManage: false`; the authed route passes it from the loader. Capability table:

| Capability | Granted when |
| --- | --- |
| `canManage` + management set (confirm/move/remove/release-anyone, stats strip, availability section) | `canManage` (admin) |
| `canAssign`, `canManageSpeakers` | `canManage` **or** `isTmod` |
| `canEditMeetingMeta` *(new)* | `canManage` **or** `isTmod` |
| `canToggleAvailability`, `canTakeOver`, `canEditOwnSpeech` | any identity (`currentMemberId !== null`) |
| `canClaim`, `canReleaseOwn` | any identity |
| `canEditWod` *(new)* | `isGrammarian && !isTmod && !canManage` |

`canEditWod` deliberately excludes admins and TMODs — they edit the word of the day through "Edit meeting", so the focused dialog only appears for the pure grammarian who otherwise has no edit path (matching today's public gate, extended with `!canManage`).

**Lifecycle gating (behavior-preserving):** the two edit capabilities (`canEditMeetingMeta`, `canEditWod`) must be suppressed for a meeting that is **locked or over**, exactly as the routes gate them today (`!over`, plus the `lockedViewer` wrapper). Extend `lockedViewer` to zero both new caps, and fold the `over` check (meeting in the past) into the derivation so a past meeting is never editable from either surface.

`isTmod` / `isGrammarian` are derived once, in a **shared helper** used by both routes (parity by construction), from the meeting's slots and the current member id:

```ts
deriveMeetingRoleFlags(slots, currentMemberId) → { isTmod, isGrammarian }
```

using the existing `isTmodRoleName` / `isGrammarianRoleName` (`src/lib/meeting-roles.ts`). Both flags are `false` when `currentMemberId` is null.

### 2. Lift the edit dialogs into `<MeetingAgenda>`

Move the two dialogs out of the route files into shared dialog components rendered by `<MeetingAgenda>`, gated on the new capabilities:

- `viewer.canEditMeetingMeta` → the unified **"Edit meeting"** dialog. One component replacing both `EditMeetingDialog` (authed) and `EditMeetingMetaDialog` (public). It takes `actorMemberId` **and** `selfMemberId`; `updateMeeting` resolves the grant (admin vs tmod-self-assert). The reschedule (`scheduledAt`) field renders **only when `viewer.canManage`** (server rejects TMOD reschedule).
- `viewer.canEditWod` → the focused **"Edit Word of the Day"** dialog (the existing `WordOfTheDayDialog`, moved to the component layer), taking `actorMemberId` + `selfMemberId`, calling `updateWordOfTheDay`.

Both surfaces inherit both dialogs from the component, so they can't drift out of sync — this is what closes #302 on the authed route (a signed-in grammarian gets the WOD dialog on `/meetings/$id`; a signed-in TMOD gets "Edit meeting").

### 3. Loader selection + data entitlement

No new loader. The meeting route picks the loader by viewer:
- **Signed-in member of the viewed club** → `getMeeting` (session-aware; admin regains management).
- **Anonymous, or signed-in non-member** → `getPublicMeeting` (hard `canManage:false`).

Contact/roster PII stays **admin-gated** (`canManage`) inside the loader — unchanged. The existing `src/routes/public-meeting-contact.guard.test.ts` stays valid (anon payload carries no PII).

### 4. `<AppShell>` extraction + membership-gated wrap

Extract the sidebar/header from `_authed.tsx` (`WorkspaceLayout` / `SidebarInner`) into a reusable `<AppShell>` that takes an explicit shell-context prop object (clubs, active club, current member id, officer positions, superadmin, impersonation, display name/initials/role label) rather than reading route context — so both `_authed.tsx` and the public wrappers can supply it.

- `_authed.tsx` renders `<AppShell>` with its `beforeLoad` context — behavior unchanged.
- The public wrappers (`club.$clubId.tsx`; the resources route's wrapper) call `getAuthContext()` in `beforeLoad`. When the visitor is a **signed-in member of the viewed club**, they render `<AppShell>` around the `<Outlet>`, skip `RequireMember` (name-pick), and use the session identity. Otherwise they render today's `ClubShell` header unchanged.
- **Identity source:** a small `useEffectiveMember` seam returns the session member id when the viewer is a signed-in member of the club, else the localStorage `useCurrentMember` pick. The route reads the effective member id; anon behavior is untouched.
- **Active club:** opening a public link for a club the member belongs to sets it active (reuse the club-switch path), so the shell nav, club name, and identity all resolve to the viewed club.

`getAuthContext()` on public routes is cheap for anonymous visitors (no session cookie → fast return).

## Phase 1 — Capability & affordance parity (closes #302)

Self-contained; needs no shell work. Verified prerequisite: `/meetings/$id` has no admin gate (only the `_authed` signed-in gate), so a signed-in non-admin member already reaches it view-only.

- Unified `meetingViewer` + `deriveMeetingRoleFlags` shared helper (§1).
- Add `canEditMeetingMeta` and `canEditWod` capabilities.
- Lift the "Edit meeting" and "Edit Word of the Day" dialogs into `<MeetingAgenda>` as shared components (§2); refactor the public route's inline dialogs away (behavior-preserving) and wire the authed route to render them via the component.
- Outcome: signed-in grammarian edits WOD and signed-in TMOD gets "Edit meeting", both on `/meetings/$id`. Public behavior unchanged.

## Phase 2 — Shell + loader selection (closes #317)

Builds on Phase 1's unified viewer.

- Extract `<AppShell>` from `_authed.tsx` (§4).
- Public wrappers render `<AppShell>` for a signed-in member of the viewed club; skip name-pick; session identity; switch-active-club-on-open.
- Loader selection: `getMeeting` for signed-in members of the club, `getPublicMeeting` for anonymous / non-members (§3).
- Outcome: signed-in users keep the shell on public routes; the admin-on-shared-link reversal takes effect.

## Non-goals

- **No Option B** — authed routes stay, URLs stable, share links keep working.
- **Anonymous experience untouched** — same honor-system boundary, same redacted public payloads, same name-pick.
- **No PII expansion** — meeting-view contact PII stays admin-gated.
- **Present / print** routes unchanged (standalone, no shell).
- **Officer "assign anyone from the grid"** remains out of scope (separate issue).
- **`/resources` (#310)** content/route stays its own in-flight work; this design only supplies the `<AppShell>` wrap mechanism it can adopt.
- **Admin "preview as member"** is #320, not part of this work.

## Edge cases / error handling

- `getAuthContext()` failure on a public route → treat as anonymous (fall back to `ClubShell`).
- Signed-in but not a member of the viewed club → anonymous public experience.
- Locked meeting → `lockedViewer` wrapper still applies (read-only) regardless of role.
- Multi-club member on a non-active club's link → active club switches to the viewed club.

## Testing

- **Unit — `meetingViewer` capability table:** non-admin member (self-serve on, no manage/meta), TMOD member (assign / speakers / meeting-meta on, no WOD dialog), pure grammarian (WOD dialog on), admin (full, no WOD dialog). Assert same-role parity regardless of session-vs-self-assert construction.
- **Unit — `deriveMeetingRoleFlags`:** TMOD / grammarian / neither / null identity.
- **Guard — `public-meeting-contact.guard.test.ts`:** anonymous payload has no PII (unchanged); add a case asserting PII is present for an admin (`canManage`).
- **Loader selection:** signed-in member of club → `getMeeting`; anon / non-member → `getPublicMeeting`.
- **#302 acceptance:** signed-in non-admin grammarian sees and uses the WOD editor on `/meetings/$id`; signed-in non-admin TMOD sees "Edit meeting".
- **#317 acceptance:** signed-in member of a club opening a public route renders inside `<AppShell>` with session identity and no name-pick; a non-member gets `ClubShell`.
- `bun run typecheck` + `bun run check` green.
