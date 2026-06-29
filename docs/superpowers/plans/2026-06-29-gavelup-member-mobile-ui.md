# GavelUp Member Mobile UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps, TDD where it pays (the identity store + gate get unit/component tests; presentational screens are verified by build + a render smoke test).

**Goal:** Build the **public, mobile-first** member surface — pick-your-name → home → meeting/claim — on a new route tree, consuming the Phase B public server fns. The authed VPE workspace (`_authed/*`) is untouched.

**Architecture:** New **public** routes (no `beforeLoad` auth): a layout `club.$clubId.tsx` (mobile shell + a `<RequireMember>` gate) with children for home and the meeting view. Identity is a localStorage `{id,name}` per club, read via a `useCurrentMember(clubId)` hook (client-only; SSR-safe). Member-agnostic reads (`getMeeting`, `listUpcomingMeetings`) load in route loaders; member-specific reads (`listMemberCommitments`) fetch client-side via TanStack Query once the member is known; mutations pass `memberId`/`actorMemberId` and `router.invalidate()`.

**Tech Stack:** React 19, TanStack Start/Router (file routes), TanStack Query (already wired), shadcn/ui (`src/components/ui/*`), GavelUp components (`src/components/club/*`), Tailwind v4, `sonner` toasts. Reuse `src/lib/agenda.ts` (`slotLabel`/`buildRoleCounts`), `src/lib/avatar.ts`, `src/lib/format.ts` (date/tz).

**Spec:** `docs/superpowers/specs/2026-06-29-gavelup-member-mobile-ui-design.md`. **Approved mockups** (visual fidelity reference): `.superpowers/brainstorm/621181-1782767272/content/{entry-model,meeting-view,home-identity}.html`. **Depends on:** Phase B (merged) — the public fns.

**Scope guard — NOT in this plan:** any `_authed/*` workspace file, any server-fn auth change, the activity-log view, multi-club switching, push/PWA. **One small server read addition is in scope** (Task 1: `getMeeting` must return role `description`).

## Commands
`bun run generate-routes` (regenerate `routeTree.gen.ts` after adding routes) · `bunx tsc --noEmit` · `bun run check` · `bun run build` · `bunx vitest run`.

## File structure
- Modify `src/server/meetings.ts` — add `description` to the `loadMeetingDetail` slot select (Task 1).
- Create `src/lib/member-identity.ts` — `useCurrentMember(clubId)` + the localStorage key helper.
- Create `src/components/club/require-member.tsx` — the gate + `PickNameScreen`.
- Create `src/routes/club.$clubId.tsx` — public layout: mobile shell + `<RequireMember>` wrapping `<Outlet/>`.
- Create `src/routes/club.$clubId.index.tsx` — home.
- Create `src/routes/club.$clubId.meeting.$meetingId.tsx` — meeting/claim.
- Tests: `src/lib/member-identity.test.ts`; `src/components/club/require-member.test.tsx`.

---

### Task 1: `getMeeting` returns role responsibilities

**Files:** Modify `src/server/meetings.ts`

- [ ] **Step 1:** In `loadMeetingDetail`'s slot `select({...})`, add `description: roleDefinitions.description,` next to `roleName`/`category`. (It's already joined to `roleDefinitions`.) This flows through `getMeeting`/`getNextMeeting` so the member meeting view can show responsibilities.
- [ ] **Step 2:** `bunx tsc --noEmit` → 0 (the return type gains `description: string | null`; the existing `_authed` meeting view ignores the extra field — verify it still compiles).
- [ ] **Step 3:** Commit `feat(server): return role description from getMeeting`.

---

### Task 2: Member identity store

**Files:** Create `src/lib/member-identity.ts`; Test: `src/lib/member-identity.test.ts`

- [ ] **Step 1 (failing test):** unit-test the pure helpers (read/write/clear, malformed JSON → null):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { readStoredMember, storeMember, clearStoredMember, memberKey } from "./member-identity";

describe("member-identity store", () => {
	const clubId = "club-1";
	afterEach(() => localStorage.clear());
	it("round-trips a member", () => {
		storeMember(clubId, { id: "m1", name: "Faisal" });
		expect(readStoredMember(clubId)).toEqual({ id: "m1", name: "Faisal" });
	});
	it("returns null when unset", () => { expect(readStoredMember(clubId)).toBeNull(); });
	it("clear removes it", () => { storeMember(clubId, { id: "m1", name: "F" }); clearStoredMember(clubId); expect(readStoredMember(clubId)).toBeNull(); });
	it("malformed value → null (not a throw)", () => { localStorage.setItem(memberKey(clubId), "{bad"); expect(readStoredMember(clubId)).toBeNull(); });
});
```

(Vitest is configured `environment: "node"`; localStorage isn't defined there. Add `// @vitest-environment jsdom` at the top of this test file — jsdom is already a devDependency.)

- [ ] **Step 2:** Run → fail. **Step 3:** Implement:

```ts
import { useCallback, useEffect, useState } from "react";

export interface StoredMember { id: string; name: string; }
export const memberKey = (clubId: string) => `gavelup:member:${clubId}`;

export function readStoredMember(clubId: string): StoredMember | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(memberKey(clubId));
		if (!raw) return null;
		const v = JSON.parse(raw);
		return typeof v?.id === "string" && typeof v?.name === "string" ? v : null;
	} catch { return null; }
}
export function storeMember(clubId: string, m: StoredMember) {
	localStorage.setItem(memberKey(clubId), JSON.stringify(m));
}
export function clearStoredMember(clubId: string) {
	localStorage.removeItem(memberKey(clubId));
}

/** SSR-safe hook. `member` is null until mounted (server render) and when unset. */
export function useCurrentMember(clubId: string) {
	const [member, setMember] = useState<StoredMember | null>(null);
	useEffect(() => { setMember(readStoredMember(clubId)); }, [clubId]);
	const set = useCallback((m: StoredMember) => { storeMember(clubId, m); setMember(m); }, [clubId]);
	const clear = useCallback(() => { clearStoredMember(clubId); setMember(null); }, [clubId]);
	return { member, mounted: member !== null, setMember: set, clearMember: clear };
}
```

> Note the SSR caveat: `member` is null during server render + first client paint; the gate must show a neutral loading state until the `useEffect` runs, to avoid hydration flicker (handled in Task 3 via a `mounted` flag tracked separately — see Step 3 there).

- [ ] **Step 4:** Run → pass. **Step 5:** commit `feat(member): localStorage identity store`.

---

### Task 3: `<RequireMember>` gate + mobile shell layout

**Files:** Create `src/components/club/require-member.tsx`, `src/routes/club.$clubId.tsx`; Test: `src/components/club/require-member.test.tsx`

- [ ] **Step 1 (failing component test):** with no stored member, `<RequireMember clubId>` renders the pick-name screen (search input + roster); after selecting, it renders children. Mock the `listMembers` server fn (return `[{id:'m1',name:'Faisal',office:null}]`). `// @vitest-environment jsdom`, Testing Library.

- [ ] **Step 2:** fail. **Step 3:** Implement `require-member.tsx`:
  - `useCurrentMember(clubId)`; track a separate `const [mounted, setMounted] = useState(false); useEffect(()=>setMounted(true),[])`.
  - While `!mounted`: render a minimal centered spinner (avoids hydration flicker).
  - If `mounted && !member`: render `<PickNameScreen clubId onPicked={setMember} />`.
  - Else: render `children` + a header affordance (passed via context or a small `useCurrentMember` re-read) for "not you?" → `clearMember`.
  - **`PickNameScreen`:** `useQuery(['members',clubId], () => listMembers({data:clubId}))`; a search `Input` filtering by name; a list of rows (reuse `MemberAvatar` from `src/components/club/member-avatar.tsx` + the name); clicking a row → `onPicked({id,name})`. A bottom "I'm new — add me" row → an `Input` for the name → `addMember({data:{clubId,name}})` → `onPicked({id: result.id, name})`. Style per the `home-identity.html` mockup.

- [ ] **Step 4:** run → pass; `bunx tsc --noEmit` → 0.
- [ ] **Step 5:** Implement `src/routes/club.$clubId.tsx` (public layout — NO `beforeLoad`):

```tsx
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "#/components/ui/sonner";
import { RequireMember } from "#/components/club/require-member";

export const Route = createFileRoute("/club/$clubId")({ component: ClubShell });

function ClubShell() {
	const { clubId } = Route.useParams();
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-background">
			<RequireMember clubId={clubId}>
				<Outlet />
			</RequireMember>
			<Toaster position="top-center" />
		</div>
	);
}
```

- [ ] **Step 6:** `bun run generate-routes` (registers the new routes) → `routeTree.gen.ts` updates. `bunx tsc --noEmit` → 0. Commit `feat(member): public club shell + RequireMember gate`.

---

### Task 4: Home — `/club/$clubId`

**Files:** Create `src/routes/club.$clubId.index.tsx`

- [ ] **Step 1:** Implement. **Loader** (server-OK, member-agnostic): `listUpcomingMeetings({ data: clubId })`. **Client (member-specific):** `useCurrentMember(clubId)` → when a member exists, `useQuery(['commitments', member.id], () => listMemberCommitments({ data: member.id }))`.
  - **Header:** "Hi {member.name} 👋", club name (from the first upcoming meeting's data or a small club fetch — reuse what's available), a "not you?" text button → `clearMember`.
  - **Your upcoming roles:** from the commitments query — each: role name, meeting date (`formatMeetingDate` + tz), speech title if speaker; a Release button (`releaseSlot({data:{slotId, actorMemberId: member.id}})` → `router.invalidate()` + refetch + toast). Empty state per the mockup.
  - **Meetings with open roles:** from the loader — each meeting with `openSlots > 0`: date/theme + an "{n} open" `Badge`/`StatusPill`, linked to `/club/$clubId/meeting/$meetingId`.
  - **Browse all meetings:** a link listing all upcoming (same loader data).
  - Match `home-identity.html` mockup.
- [ ] **Step 2:** `bun run generate-routes`; `bunx tsc --noEmit` → 0; `bun run build` → 0 (SSR renders without the member; the commitments section shows a loading/empty state until mounted).
- [ ] **Step 3:** Commit `feat(member): home (your roles + meetings with openings)`.

---

### Task 5: Meeting / claim — `/club/$clubId/meeting/$meetingId`

**Files:** Create `src/routes/club.$clubId.meeting.$meetingId.tsx`

This is the core screen — model it on the existing `src/routes/_authed/meetings.$id.tsx` (which already does grouped roles, the claim/release handlers, and a speaker `Sheet`), adapted to the public/member surface.

- [ ] **Step 1:** Implement.
  - **Loader:** `getMeeting({ data: meetingId })` → `{ meeting, slots, canManage, timezone }` (slots now include `description`).
  - **Identity:** `useCurrentMember(clubId)`; all writes use `member.id` as `memberId`/`actorMemberId`. If `!member` the gate already handled it (this route is under the layout), but guard writes with a toast if somehow null.
  - **Header:** theme, `formatMeetingDate`/`Time` (with `timezone`), location; a **"I can't make this one"** toggle → `setAvailability`/`clearAvailability({data:{memberId,meetingId,clubId}})` + invalidate + toast. (Track current availability: add the member's availability to the loader OR a small `useQuery`; simplest — a client `useQuery(['avail', member.id, meetingId])` is overkill, so include an `unavailableMemberIds` set in `getMeeting`'s return in a fast-follow; for v1, treat the toggle as optimistic + show state from a dedicated lightweight fetch. **If wiring availability state cleanly needs a `getMeeting` field, STOP and note it** — don't hack it.)
  - **Roles grouped by category** (`buildRoleCounts(slots)` + `slotLabel(slot, counts)` from `src/lib/agenda.ts`; preserve category order as `meetings.$id.tsx` does). Each row: label, a `StatusPill` (open / "you" when `slot.assigneeId === member.id` / filled-with-`assigneeName`), evaluator→speaker line where `slot.evaluates`.
  - **Tap an open role → bottom `Sheet`** (`src/components/ui/sheet`): the role's `description` (responsibilities) + a **Claim** button → `claimSlot({data:{slotId, memberId: member.id, actorMemberId: member.id}})`. For `slot.isSpeakerRole`, render the speech-details form FIRST (copy the field set from `meetings.$id.tsx`'s `ClaimSpeakerSheet`: speechTitle required, pathwayPath, projectName, projectLevel, min/maxMinutes) and pass `speakerDetails` in the claim payload.
  - **Your rows:** a **Release** (`releaseSlot({data:{slotId, actorMemberId: member.id}})`). **Someone else's filled row:** a small **"take over"** that calls `reassignSlot({data:{slotId, assigneeMemberId: member.id, actorMemberId: member.id}})` behind a **soft confirm** ("This is {name}'s slot — take it over?") using the `Dialog` component.
  - Every mutation: `await … ; toast.success(...); await router.invalidate()` (and refetch the commitments query if relevant). Errors → `toast.error(errMessage(err))` (reuse the `errMessage` helper pattern from `meetings.$id.tsx`).
  - Match the `meeting-view.html` mockup (layout A).
- [ ] **Step 2:** `bun run generate-routes`; `bunx tsc --noEmit` → 0; `bun run build` → 0.
- [ ] **Step 3:** Commit `feat(member): meeting view + claim/release/reassign/availability`.

---

### Task 6: Full green + route smoke

- [ ] **Step 1:** `bun run generate-routes` (no diff if already current). `bunx tsc --noEmit` → 0. `bun run check` → 0. `bun run build` → 0. `bunx vitest run` → the identity + gate tests pass; integration suites skipped without a DB.
- [ ] **Step 2:** Confirm the new routes are public: `grep -n "beforeLoad" src/routes/club.\$clubId*.tsx` → **no matches** (no auth gate).
- [ ] **Step 3:** Manual smoke (document, don't commit data): `bun run dev`, open `/club/<seeded clubId>/meeting/<meetingId>` in a fresh browser (no session) → pick name → claim a role → release → mark Not-Available. Confirm the `_authed` workspace still loads.
- [ ] **Step 4:** Commit any fixups.

---

## Self-review (against the spec)

- **Entry (hybrid C):** public `/club/$clubId` (home) + `/club/$clubId/meeting/$meetingId` (Tasks 3–5); a shared link deep-links to the meeting and the gate prompts pick-name once if needed (Task 3). ✓
- **Identity:** localStorage `{id,name}`, SSR-safe hook, searchable pick-name + self-add, "not you?" (Tasks 2–3). ✓
- **Meeting view (layout A):** grouped roles, tap-to-claim sheet with responsibilities (`description` added in Task 1) + speaker form, Not-Available, Release, reassign soft-confirm (Task 5). ✓
- **Home:** your roles + meetings with openings + browse (Task 4). ✓
- **Reuse:** `slotLabel`/`buildRoleCounts`, `MemberAvatar`, `StatusPill`, `Sheet`, `Dialog`, `format.ts`. ✓
- **Public:** no `beforeLoad` on the club routes (Task 6 grep). ✓
- **Placeholder check:** the only soft spot is the availability *current-state* display (Task 5) — flagged with a STOP-and-note if it needs a `getMeeting` field, rather than hand-waved. Everything else has concrete code or a precise component spec + mockup reference.

## STOP conditions
- If `getMeeting` can't cleanly surface the current member's availability for the toggle's state, STOP and report (likely a small loader field — coordinate rather than hack a second fetch).
- If a route fails to register in `routeTree.gen.ts` after `generate-routes`, STOP (file-naming issue).
- If anything requires touching `_authed/*` or a server-fn auth guard, STOP (out of scope — Phase B is done).

## Maintenance notes
- Availability current-state is the one likely fast-follow (add an `unavailableMemberIds`/per-member flag to `getMeeting`).
- localStorage identity is per-device (re-pick on a new phone) — by design.
- When multi-club arrives, the `clubId` is already in the route + the storage key is per-club.
