# Signed-in Member Parity — Phase 2 (Shell-wrap + Loader Selection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in member of a club keeps the app shell (sidebar chrome) on that club's public routes — no sign-in re-prompt, no name-pick, identity from the session, entitled data — while anonymous visitors keep today's exact bare experience. Closes #317.

**Architecture:** Extract the sidebar shell from `_authed.tsx` into a reusable `<AppShell>`. The public wrappers (`club.$clubId.tsx`, the resources route) call `getAuthContext()` in `beforeLoad`; when the viewer is a signed-in member of the viewed club they render `<AppShell>` (switching the active club to the viewed one first), skip the name-pick, and use the session identity; otherwise they render today's lightweight header unchanged. The public meeting route selects `getMeeting` (session-aware) for members vs `getPublicMeeting` for anonymous visitors.

**Tech Stack:** TanStack Start (React 19, SSR/Nitro), TypeScript strict, Vitest + `@testing-library/react` (jsdom, use `.toBeTruthy()`/`.toBeNull()` — `jest-dom` is NOT wired), Biome (tabs, double quotes). Bun. Import alias `#/*` → `src/*`.

**Source spec:** `docs/superpowers/specs/2026-07-21-signed-in-member-parity-design.md` (Phase 2 section). Phase 1 (unified viewer + lifted dialogs, #302) already merged (`b7b7b4c`).

**Working directory:** worktree `.claude/worktrees/shell-wrap-317` (branch `feat/317-shell-wrap`). Run all commands there; confirm `git rev-parse --show-toplevel` ends in `shell-wrap-317`.

**Verified facts:**
- `getAuthContext` (`src/server/auth-context.ts`) is a `createServerFn` returning `{ user: {id,name,email}|null, clubs: {clubId,name,clubNumber,clubRole}[], currentMemberId: string|null, activeClubId: string|null, officerPositions, isSuperadmin, impersonating }`. For anonymous it returns nulls/empties. `currentMemberId` is scoped to the **active** club.
- `setActiveClub({ clubId })` (`src/server/auth-context.ts`) is a `createServerFn` that sets a cookie; `getAuthContext` re-validates it on the next read.
- `_authed.tsx`: `WorkspaceLayout` (from L112) reads route context and derives `activeClub`, `clubName`, `clubNumber`, `hasOffice`, `isOfficer`, `roleLabel`, `displayName`, `initials`, `searchGrants`, `handleSignOut`, `handleExitImpersonation`; the shell markup is the returned `<div>…</div>` (the sticky `<aside>` desktop sidebar, the mobile `<Sheet>` drawer, `<main>` with impersonation banner + desktop/mobile headers + `<Outlet/>` + footer + `<Toaster/>`), with `SidebarInner` (from L296) as the sidebar body and a local `crumbFor(pathname)`.
- `club.$clubId.tsx`: `ClubShell` (lightweight header: `BrandMark`, club name, `ThemeToggle`, "Sign in" link) wraps `<RequireMember>` → `<Outlet/>`. `beforeLoad` resolves `{ clubUuid, clubSlug, clubName, clubNumber }` via `resolveClubOrRedirect`.
- `RequireMember` (`src/components/club/require-member.tsx`) gates on `useCurrentMember(clubSlug)` (localStorage) → shows `PickNameScreen` until a name is picked, then `children`.
- Public meeting route (`club.$clubId.meeting.$meetingId.tsx`) loader calls `getPublicMeeting`; the authed route (`_authed/meetings.$id.tsx`) loader calls `getMeeting` (session-aware `canManage`, admin-gated PII). Both render the shared `<MeetingAgenda>` with the unified `meetingViewer` (Phase 1).

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/components/app-shell.tsx` | Reusable sidebar shell (chrome + nav) | **Create** (extracted from `_authed.tsx`) |
| `src/routes/_authed.tsx` | Authed layout | **Modify** — render `<AppShell>` |
| `src/lib/public-shell.ts` | Plain, testable shell-wrap decision | **Create** |
| `src/lib/public-shell.test.ts` | Its unit tests | **Create** |
| `src/lib/member-identity.ts` | Identity store + `useEffectiveMember` seam | **Modify** — add `useEffectiveMember` |
| `src/routes/club.$clubId.tsx` | Public club layout | **Modify** — shell-wrap decision + switch-active |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Public meeting route | **Modify** — loader selection + effective identity |
| `src/routes/resources.index.tsx`, `src/routes/resources.$slug.tsx` | Public resources | **Modify** — shell-wrap when signed-in |

---

## Task 1: Extract `<AppShell>` from `_authed.tsx`

Behavior-preserving refactor. Move the shell chrome into a reusable component driven by explicit props, so both `_authed.tsx` and the public wrappers can render it.

**Files:** Create `src/components/app-shell.tsx`; Modify `src/routes/_authed.tsx`.

- [ ] **Step 1: Define the `AppShell` props contract**

Create `src/components/app-shell.tsx`. Move the shell markup that `WorkspaceLayout` currently returns (the outer `<div>` with the desktop `<aside>`, the mobile `<Sheet>`, and `<main>` … `<Outlet/>` … footer … `<Toaster/>`) plus the `SidebarInner` function and the local `crumbFor(pathname)` helper into this file. Export `AppShell` with this props interface (every value `WorkspaceLayout` derives becomes a prop; `children` replaces `<Outlet/>` so a route can pass its own content):

```tsx
export interface AppShellProps {
	clubs: readonly { clubId: string; name: string; clubNumber: string | null; clubRole: "admin" | "member" }[];
	activeClubId: string | null;
	clubName: string;
	clubNumber: string | null;
	isOfficer: boolean;
	hasOffice: boolean;
	isSuperadmin: boolean;
	roleLabel: string;
	displayName: string;
	initials: string;
	impersonating: { clubName?: string; expiresAt: string | Date; mode: string } | null;
	searchGrants: { hasOffice: boolean; isOfficer: boolean; isSuperadmin: boolean };
	onSignOut: () => void;
	onExitImpersonation: () => void;
	children: React.ReactNode;
}
```
Inside `AppShell`, keep the `navOpen` state, the `drawerSearchRef`, `useRouterState` for `pathname`, and the `sidebar()` render helper — they are shell-local. `SidebarInner` stays internal to this file (it already takes explicit props). Replace `<Outlet/>` in the `<main>` content `<section>` with `{children}`.

- [ ] **Step 2: Render `<AppShell>` from `WorkspaceLayout`**

In `src/routes/_authed.tsx`: keep `WorkspaceLayout` reading route context + deriving the display values + `handleSignOut`/`handleExitImpersonation` + the `NoClubScreen` early return. Replace the returned shell markup with:
```tsx
	return (
		<AppShell
			clubs={clubs}
			activeClubId={activeClubId}
			clubName={clubName}
			clubNumber={clubNumber}
			isOfficer={isOfficer}
			hasOffice={hasOffice}
			isSuperadmin={isSuperadmin}
			roleLabel={roleLabel}
			displayName={displayName}
			initials={initials}
			impersonating={impersonating}
			searchGrants={searchGrants}
			onSignOut={handleSignOut}
			onExitImpersonation={handleExitImpersonation}
		>
			<Outlet />
		</AppShell>
	);
```
Import `AppShell` from `#/components/app-shell`. Remove the now-moved `SidebarInner`, `crumbFor`, and any imports that moved with them (strict TS: remove unused). Keep `_authed.tsx`'s `beforeLoad`, `NoClubScreen`, and `WorkspaceLayout`'s context/derivation.

- [ ] **Step 3: Verify (behavior-preserving — no test change needed)**

Run: `bun run typecheck` → clean. Run: `bunx vitest run src/lib/authed-nav-coverage.test.ts src/components/club/global-search.test.tsx` → PASS (the nav-coverage guard reads `_authed.tsx` source for `to="…"` links — since the `NavItem`s moved to `app-shell.tsx`, **update that test** to read `src/components/app-shell.tsx` instead of `src/routes/_authed.tsx`; it's the only assertion that inspects the shell source).

- [ ] **Step 4: Commit**

```bash
git add src/components/app-shell.tsx src/routes/_authed.tsx src/lib/authed-nav-coverage.test.ts
git commit -m "refactor(shell): extract <AppShell> from _authed.tsx (#317)"
```

---

## Task 2: `publicShellDecision` — the membership-gated shell-wrap rule

A plain, unit-testable function that decides, from an auth-context result + the viewed club id, whether to shell-wrap and what identity/active-switch is needed. No React, no db — pure logic.

**Files:** Create `src/lib/public-shell.ts` + `src/lib/public-shell.test.ts`.

- [ ] **Step 1: Failing test**

Create `src/lib/public-shell.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { publicShellDecision } from "./public-shell";

const ctx = (over: Partial<Parameters<typeof publicShellDecision>[0]> = {}) => ({
	user: { id: "u1", name: "A", email: "a@x.test" },
	clubs: [{ clubId: "cA", name: "A", clubNumber: null, clubRole: "member" as const }],
	currentMemberId: "mA",
	activeClubId: "cA",
	...over,
});

describe("publicShellDecision", () => {
	it("anonymous → no shell, no identity", () => {
		const d = publicShellDecision({ user: null, clubs: [], currentMemberId: null, activeClubId: null }, "cA");
		expect(d).toEqual({ shell: false, effectiveMemberId: null, switchActiveTo: null });
	});

	it("signed-in member of the viewed active club → shell + session identity, no switch", () => {
		expect(publicShellDecision(ctx(), "cA")).toEqual({ shell: true, effectiveMemberId: "mA", switchActiveTo: null });
	});

	it("signed-in member of a NON-active viewed club → switch active, no identity yet", () => {
		const d = publicShellDecision(
			ctx({ clubs: [
				{ clubId: "cA", name: "A", clubNumber: null, clubRole: "member" },
				{ clubId: "cB", name: "B", clubNumber: null, clubRole: "member" },
			], activeClubId: "cA", currentMemberId: "mA" }),
			"cB",
		);
		expect(d).toEqual({ shell: false, effectiveMemberId: null, switchActiveTo: "cB" });
	});

	it("signed-in NON-member of the viewed club → anonymous experience", () => {
		expect(publicShellDecision(ctx(), "cZ")).toEqual({ shell: false, effectiveMemberId: null, switchActiveTo: null });
	});
});
```

- [ ] **Step 2: Run → fails** (`publicShellDecision` not exported).

Run: `bunx vitest run src/lib/public-shell.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/lib/public-shell.ts`**

```ts
/** The shell-wrap decision for a public route, from the auth-context result and
 *  the club whose URL is being viewed. Pure — the route acts on the result. */
export interface AuthContextLite {
	user: { id: string } | null;
	clubs: readonly { clubId: string }[];
	currentMemberId: string | null;
	activeClubId: string | null;
}

export interface ShellDecision {
	/** Render <AppShell> (signed-in member of the viewed club, and it's active). */
	shell: boolean;
	/** The session member id to act as (non-null only when `shell`). */
	effectiveMemberId: string | null;
	/** A club id to switch the active club to first, then re-resolve (a member of
	 *  a non-active viewed club); null when no switch is needed. */
	switchActiveTo: string | null;
}

export function publicShellDecision(
	ctx: AuthContextLite,
	viewedClubId: string,
): ShellDecision {
	const memberOfViewed = !!ctx.user && ctx.clubs.some((c) => c.clubId === viewedClubId);
	if (!memberOfViewed) {
		return { shell: false, effectiveMemberId: null, switchActiveTo: null };
	}
	if (ctx.activeClubId !== viewedClubId) {
		// Member of the viewed club, but it isn't active — switch, then the route
		// re-runs and currentMemberId resolves for the viewed club.
		return { shell: false, effectiveMemberId: null, switchActiveTo: viewedClubId };
	}
	return { shell: true, effectiveMemberId: ctx.currentMemberId, switchActiveTo: null };
}
```

- [ ] **Step 4: Run → passes.** `bunx vitest run src/lib/public-shell.test.ts` → PASS (4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/public-shell.ts src/lib/public-shell.test.ts
git commit -m "feat(shell): membership-gated public-shell decision helper (#317)"
```

---

## Task 3: Shell-wrap `club.$clubId.tsx`

`beforeLoad` resolves the auth context + decision; the component renders `<AppShell>` for a signed-in member (skipping the name-pick), else today's `ClubShell`.

**Files:** Modify `src/routes/club.$clubId.tsx`.

- [ ] **Step 1: Resolve the decision in `beforeLoad`**

Extend the existing `beforeLoad` (after `resolveClubOrRedirect`): call `getAuthContext()`, compute `publicShellDecision(ctx, club.id)`. If `decision.switchActiveTo`, call `setActiveClub({ data: { clubId: decision.switchActiveTo } })` and `throw redirect({ to: ".", params, search })` (re-run beforeLoad with the viewed club now active). Return the club fields **plus** the shell context the component needs:
```ts
		const ctx = await getAuthContext();
		const decision = publicShellDecision(ctx, club.id);
		if (decision.switchActiveTo) {
			await setActiveClub({ data: { clubId: decision.switchActiveTo } });
			throw redirect({ to: "/club/$clubId", params: { clubId: params.clubId }, search: (s) => s });
		}
		return {
			clubUuid: club.id,
			clubSlug: club.slug,
			clubName: club.name,
			clubNumber: club.clubNumber,
			shell: decision.shell,
			effectiveMemberId: decision.effectiveMemberId,
			authCtx: decision.shell ? ctx : null,
		};
```
(Import `getAuthContext`, `setActiveClub` from `#/server/auth-context`, `publicShellDecision` from `#/lib/public-shell`, `redirect` from `@tanstack/react-router`.)

- [ ] **Step 2: Render `<AppShell>` or `ClubShell`**

In `ClubShell`, read `shell` + `authCtx` from route context. When `shell`, render `<AppShell>` (derive its display props from `authCtx` exactly as `WorkspaceLayout` does — extract that derivation into a shared `shellPropsFromContext(authCtx)` helper in `app-shell.tsx` and use it in BOTH `_authed.tsx` and here to avoid drift) around `<Outlet/>`, and do NOT wrap in `<RequireMember>` (the session identity is known). When `!shell`, render today's lightweight header + `<RequireMember>` unchanged.

- [ ] **Step 3: Tests**

`publicShellDecision` is unit-tested (Task 2). For this route, add a focused render smoke test only if a harness exists; otherwise rely on typecheck + the decision unit tests + manual QA (the route needs a full router+auth context to render, which the repo does not currently harness — note this explicitly rather than fabricating a brittle test).

- [ ] **Step 4: Verify + commit**

Run: `bun run typecheck` → clean; `bun run check` → exit 0.
```bash
git add src/routes/club.\$clubId.tsx src/components/app-shell.tsx
git commit -m "feat(shell): wrap the public club route in <AppShell> for signed-in members (#317)"
```

---

## Task 4: `useEffectiveMember` identity seam

A signed-in member uses the session identity on public routes; anonymous visitors keep the localStorage pick.

**Files:** Modify `src/lib/member-identity.ts`; Modify `src/routes/club.$clubId.meeting.$meetingId.tsx` and the club index route to consume it.

- [ ] **Step 1: Add `useEffectiveMember`**

In `src/lib/member-identity.ts`, add a hook that prefers a passed session member id over the localStorage store:
```ts
/** The member id to act as on a public route: the signed-in session member when
 *  present (shell-wrapped), else the localStorage-picked member (anonymous). */
export function useEffectiveMember(clubSlug: string, sessionMemberId: string | null) {
	const picked = useCurrentMember(clubSlug);
	if (sessionMemberId) {
		return { member: { id: sessionMemberId } as StoredMember, setMember: picked.setMember, source: "session" as const };
	}
	return { ...picked, source: "anon" as const };
}
```
(Adjust the returned `member` shape to match `StoredMember` — carry the session id; a display name isn't needed on public routes when shelled since the shell shows it.)

- [ ] **Step 2: Consume it in the public routes**

In `club.$clubId.meeting.$meetingId.tsx` and the club index route, replace `useCurrentMember(clubId)` with `useEffectiveMember(clubId, effectiveMemberId)` (reading `effectiveMemberId` from route context). The `myId` used to build the `actions`/`viewer` then comes from the session for a shelled member.

- [ ] **Step 3: Verify + commit**

Run: `bun run typecheck` → clean; existing `member-identity` tests pass (add a small unit test for `useEffectiveMember`'s session-preference if the file is testable without a DOM; otherwise a jsdom test mirroring existing ones).
```bash
git add src/lib/member-identity.ts src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/club.\$clubId.index.tsx
git commit -m "feat(shell): useEffectiveMember — session identity on shelled public routes (#317)"
```

---

## Task 5: Loader selection on the public meeting route

A signed-in member of the club loads via the session-aware `getMeeting` (admin regains management); anonymous via `getPublicMeeting`.

**Files:** Modify `src/routes/club.$clubId.meeting.$meetingId.tsx`.

- [ ] **Step 1: Select the loader by shell decision**

In the route loader, branch on the `shell` flag from `club.$clubId` route context: `const load = context.shell ? getMeeting : getPublicMeeting; const data = await load({ data: params.meetingId });`. Both return the same shape the component already consumes. Keep the existing club-mismatch `notFound()` guard and the `navItems` derivation.

- [ ] **Step 2: Verify the PII guard still holds**

Run: `bunx vitest run src/routes/public-meeting-contact.guard.test.ts` → PASS (anonymous path still uses `getPublicMeeting` → no PII). `getMeeting` only exposes contact when `canManage` (admin), unchanged.

- [ ] **Step 3: Verify + commit**

Run: `bun run typecheck` → clean.
```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(shell): signed-in members load the meeting via the session-aware loader (#317)"
```

---

## Task 6: Shell-wrap the resources routes

`/resources` and `/resources/$slug` are public-only (no club param). For a signed-in user, wrap them in `<AppShell>` too so they don't drop out of the app.

**Files:** Modify `src/routes/resources.index.tsx`, `src/routes/resources.$slug.tsx`.

- [ ] **Step 1: Decision (no club scoping)**

Resources aren't club-scoped, so the rule is simpler: shell-wrap whenever the user is signed in with at least one club (`ctx.user && ctx.clubs.length > 0`). In each route's `beforeLoad`, call `getAuthContext()` and return `{ shell: !!ctx.user && ctx.clubs.length > 0, authCtx }` alongside the existing loader data.

- [ ] **Step 2: Render**

Wrap the page content in `<AppShell>` (via `shellPropsFromContext(authCtx)`) when `shell`, else keep today's bare lightweight header (the #310 escape hatch). Add a "Resources" nav item to `AppShell`'s sidebar if not already present (check `app-shell.tsx` — link `to="/resources"`), so a shelled user has a way back.

- [ ] **Step 3: Verify + commit**

Run: `bun run typecheck` → clean; `bunx vitest run src/lib/authed-nav-coverage.test.ts` → PASS.
```bash
git add src/routes/resources.index.tsx src/routes/resources.\$slug.tsx src/components/app-shell.tsx
git commit -m "feat(shell): wrap the public resources routes in <AppShell> for signed-in users (#317)"
```

---

## Task 7: Full verification + #317 acceptance

**Files:** none unless a gap surfaces.

- [ ] **Step 1:** `bun run typecheck` → clean (fix any unused-symbol errors from the extraction).
- [ ] **Step 2:** `bun run check` → exit 0 (`bunx biome check src --write` if a format issue in your files).
- [ ] **Step 3:** `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test` → all pass.
- [ ] **Step 4:** `bun run db:generate` → `No schema changes`.
- [ ] **Step 5: #317 acceptance (reasoning + QA via dev-login):**
  - Signed-in member opens `/club/$clubId/meeting/$id` for their club → renders inside `<AppShell>` (sidebar), no name-pick, session identity, loads via `getMeeting`.
  - Signed-in **admin** opens the same public link → full management + shell (the intended reversal; preview-member-view is the separate #320).
  - Signed-in member opens a **different** club's link → today's anonymous experience (`ClubShell`, name-pick) — no shell, no leak.
  - Multi-club member opens a non-active club's link → active switches, then shells.
  - Anonymous visitor → bare `ClubShell`, name-pick, `getPublicMeeting`, no PII (guard test green).
- [ ] **Step 6:** Commit any verification fixes: `git commit -am "chore(shell): phase-2 verification fixes (#317)"`.

## Notes / risks
- **AppShell derivation drift:** `shellPropsFromContext(authCtx)` must be the single source of the shell's display props, used by `_authed.tsx` AND the public wrappers — otherwise the two shells diverge (the exact class of bug Phase 1 fixed for the viewer). Task 1/3 introduce it; keep it authoritative.
- **`beforeLoad` cost for anonymous visitors:** `getAuthContext()` returns fast with no session cookie — acceptable on public routes.
- **Route-render tests:** these routes need a full router + server-fn context the repo doesn't harness today; the plan pushes correctness into the unit-tested `publicShellDecision` + `shellPropsFromContext` and typecheck, and lists explicit QA steps rather than fabricating brittle render tests. If a lightweight harness is added later, add render coverage for the shell/no-shell branches.
