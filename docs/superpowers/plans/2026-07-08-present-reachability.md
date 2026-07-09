# Present/Print Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing public club meeting pages — Present mode, Print, and prev/next navigation — reachable from the signed-in workspace views (`/agenda`, `/meetings/$id`), without cloning any pages.

**Architecture:** Present and Print are already auth-agnostic standalone routes (`/club/$clubId/meeting/$meetingId/{present,print}`) that render from a club slug + meeting id. A new shared `<MeetingViewActions>` component renders the two launch buttons so the signed-in views can't re-diverge. Prev/next reuses the existing `MeetingNavStrip`, made route-agnostic via an optional `getLinkProps` builder (default preserves the public route; the authed view passes a builder targeting `/meetings/$id` so paging stays in the workspace).

**Tech Stack:** TanStack Start (React 19), TanStack Router (typed `<Link>`), Drizzle server-fns, shadcn/ui + Tailwind v4, Vitest, Biome. Package manager: **Bun**.

**Spec:** `docs/superpowers/specs/2026-07-08-present-reachability-design.md` (issues #140 + #142).

---

## Prerequisites — worktree setup (run once)

This plan executes in the `140-present-reachability` worktree (`../tm-scheduler-140`). A fresh
worktree has no `node_modules` and no env file, so build/test/typecheck will fail until set up.

- [ ] **Install deps + copy env into the worktree**

Run from the worktree root:
```bash
bun install
cp ../tm-scheduler/.env.local .env.local
```
Expected: `bun install` completes; `.env.local` now exists in the worktree.

- [ ] **Sanity-check the toolchain**

Run:
```bash
bunx tsc --noEmit
```
Expected: completes with no errors (baseline is green before any changes).

**Notes for the executor:**
- No new **route** files are added, so `src/routeTree.gen.ts` must NOT change. Do not run
  `bun run build` to typecheck (it appends an SSR Register block to `routeTree.gen.ts`); use
  `bunx tsc --noEmit` instead. If `routeTree.gen.ts` ever shows as modified, revert it with
  `git checkout src/routeTree.gen.ts`.
- Biome formats with **tabs** and **double quotes**. Run `bun run check` before each commit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/components/club/meeting-view-actions.tsx` | Shared Print + Present launch buttons (links to public standalone pages, new tab) | **Create** |
| `src/lib/meeting-nav.ts` | Add exported `defaultMeetingNavLinkProps` builder (pure) | Modify |
| `src/lib/meeting-nav.test.ts` | Unit test for the default builder | **Create** |
| `src/components/club/meeting-nav-strip.tsx` | Accept optional `getLinkProps`; default = public route | Modify |
| `src/routes/_authed/agenda.tsx` | Swap inline Print link for `<MeetingViewActions>` | Modify |
| `src/routes/_authed/meetings.$id.tsx` | Add `<MeetingViewActions>`; loader fetch upcoming; render `<MeetingNavStrip>` | Modify |

**Commit grouping (per spec sequencing):**
- **Commit 1 (#140 pre-launch fix):** Tasks 1–3 — Present/Print reachable from both views.
- **Commit 2 (#142):** Tasks 4–6 — prev/next in `/meetings/$id`.

---

## Task 1: Create the shared `<MeetingViewActions>` component

**Files:**
- Create: `src/components/club/meeting-view-actions.tsx`

- [ ] **Step 1: Write the component**

The `to` values use the **URL path** form (no `_` escape suffix); the print route accepts a
`layout` search param (defaults to `timing`), matching the existing links in `agenda.tsx:184`
and `club.$clubId.meeting.$meetingId.tsx:355,367`.

```tsx
import { Link } from "@tanstack/react-router";
import { Presentation, Printer } from "lucide-react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { Button } from "#/components/ui/button";

/**
 * Print + Present launch buttons for a meeting. Both open the public,
 * auth-agnostic standalone pages (which take a club slug + meeting id) in a new
 * tab. Shared by the signed-in agenda and meeting-detail views so their
 * external-launch affordances can't re-diverge (issue #140).
 */
export function MeetingViewActions({
	clubSlug,
	meetingId,
	printLayout = "timing",
}: {
	clubSlug: string;
	meetingId: string;
	printLayout?: AgendaLayout;
}) {
	return (
		<>
			<Button asChild variant="outline" size="sm">
				<Link
					to="/club/$clubId/meeting/$meetingId/print"
					params={{ clubId: clubSlug, meetingId }}
					search={{ layout: printLayout }}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Printer />
					Print agenda
				</Link>
			</Button>
			<Button asChild variant="outline" size="sm">
				<Link
					to="/club/$clubId/meeting/$meetingId/present"
					params={{ clubId: clubSlug, meetingId }}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Presentation />
					Present
				</Link>
			</Button>
		</>
	);
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS (no errors). If `to` or `search` mismatches, confirm the route paths and that
`AgendaLayout` is exported from `#/components/agenda/meeting-agenda-print`.

- [ ] **Step 3: Lint/format**

Run: `bun run check`
Expected: PASS (no diffs after formatting).

## Task 2: Wire `<MeetingViewActions>` into `/agenda`

**Files:**
- Modify: `src/routes/_authed/agenda.tsx` (header action row, ~lines 182–203; imports)

- [ ] **Step 1: Add the import**

Add alongside the existing imports (keep the existing `Link` import — it's still used by the
empty-state "Schedule a meeting" link):
```tsx
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
```

- [ ] **Step 2: Replace the inline Print button with the shared component**

Find this block (the header action row):
```tsx
					<div className="flex gap-[9px]">
						<Button asChild variant="outline" size="sm">
							<Link
								to="/club/$clubId/meeting/$meetingId/print"
								params={{ clubId: clubSlug, meetingId: meeting.id }}
								search={{ layout: "timing" }}
								target="_blank"
								rel="noopener noreferrer"
							>
								Print agenda
							</Link>
						</Button>
						{canManage ? (
							<Button
								size="sm"
								onClick={() => toast.info("Reminder sending isn't wired up yet.")}
							>
								Remind unfilled
							</Button>
						) : null}
					</div>
```

Replace it with:
```tsx
					<div className="flex gap-[9px]">
						<MeetingViewActions clubSlug={clubSlug} meetingId={meeting.id} />
						{canManage ? (
							<Button
								size="sm"
								onClick={() => toast.info("Reminder sending isn't wired up yet.")}
							>
								Remind unfilled
							</Button>
						) : null}
					</div>
```

- [ ] **Step 3: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS. (Strict TS fails on unused symbols — confirm no import became unused. `Link` is
still used by the empty state; `toast` still used by "Remind unfilled".)

## Task 3: Wire `<MeetingViewActions>` into `/meetings/$id`

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx` (header action area, ~lines 265–279; imports)

- [ ] **Step 1: Add the import**

```tsx
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
```

- [ ] **Step 2: Group the header actions into one row and add the component**

Find this block in the `<header>`:
```tsx
					<ShareLinkButton
						path={`/club/${clubSlug}/meeting/${meeting.id}`}
						label="Copy member link"
						className="mt-1"
					/>
					{canManage ? (
						<Button
							size="sm"
							variant="outline"
							className="mt-1 ml-2"
							onClick={() => setEditOpen(true)}
						>
							Edit meeting
						</Button>
					) : null}
```

Replace it with (wraps the actions so the extra buttons wrap cleanly):
```tsx
					<div className="flex flex-wrap items-center gap-2 pt-1">
						<ShareLinkButton
							path={`/club/${clubSlug}/meeting/${meeting.id}`}
							label="Copy member link"
						/>
						<MeetingViewActions clubSlug={clubSlug} meetingId={meeting.id} />
						{canManage ? (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setEditOpen(true)}
							>
								Edit meeting
							</Button>
						) : null}
					</div>
```

- [ ] **Step 3: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit (closes the #140 pre-launch blocker)**

```bash
git add src/components/club/meeting-view-actions.tsx src/routes/_authed/agenda.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat: Present/Print reachable from signed-in meeting views (#140)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Add the pure `defaultMeetingNavLinkProps` builder (TDD)

**Files:**
- Modify: `src/lib/meeting-nav.ts`
- Test: `src/lib/meeting-nav.test.ts` (create)

The builder returns TanStack `LinkProps` so both the default and the authed builders stay
**type-safe** (a concrete valid `{ to, params }` object is assignable to the `LinkProps` union),
while remaining a plain object that's trivially unit-testable. `LinkProps` is imported
**type-only**, so `meeting-nav.ts` stays a pure, node-testable module.

- [ ] **Step 1: Write the failing test**

Create `src/lib/meeting-nav.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultMeetingNavLinkProps } from "./meeting-nav";

describe("defaultMeetingNavLinkProps", () => {
	it("targets the public club meeting route with both params", () => {
		expect(defaultMeetingNavLinkProps("koala-tm", "m-123")).toEqual({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: "koala-tm", meetingId: "m-123" },
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/meeting-nav.test.ts`
Expected: FAIL — `defaultMeetingNavLinkProps` is not exported / not a function.

- [ ] **Step 3: Implement the builder**

In `src/lib/meeting-nav.ts`, add the type-only import at the top (after the existing
`import { formatShortDate } from "./format";`):
```ts
import type { LinkProps } from "@tanstack/react-router";
```

Add this exported function at the end of the file:
```ts
/**
 * Default destination for a nav-strip item: the public club meeting page.
 * Signed-in views pass their own builder (targeting `/meetings/$id`) so paging
 * stays inside the workspace instead of jumping to the public tree (#140/#142).
 */
export function defaultMeetingNavLinkProps(
	clubId: string,
	meetingId: string,
): LinkProps {
	return {
		to: "/club/$clubId/meeting/$meetingId",
		params: { clubId, meetingId },
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/meeting-nav.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS.

## Task 5: Make `MeetingNavStrip` route-agnostic

**Files:**
- Modify: `src/components/club/meeting-nav-strip.tsx`

- [ ] **Step 1: Update imports**

Change the existing import line:
```tsx
import type { MeetingNavItem } from "#/lib/meeting-nav";
```
to:
```tsx
import { defaultMeetingNavLinkProps, type MeetingNavItem } from "#/lib/meeting-nav";
import type { LinkProps } from "@tanstack/react-router";
```

- [ ] **Step 2: Add the optional `getLinkProps` prop with a default**

Change the component signature/props from:
```tsx
export function MeetingNavStrip({
	clubId,
	items,
}: {
	clubId: string;
	items: MeetingNavItem[];
}) {
```
to:
```tsx
export function MeetingNavStrip({
	clubId,
	items,
	getLinkProps,
}: {
	clubId: string;
	items: MeetingNavItem[];
	getLinkProps?: (meetingId: string) => LinkProps;
}) {
	const linkPropsFor =
		getLinkProps ?? ((meetingId: string) => defaultMeetingNavLinkProps(clubId, meetingId));
```

- [ ] **Step 3: Render the link from the builder**

Replace the existing `<Link>` opening (currently hard-coded `to`/`params`):
```tsx
							<Link
								to="/club/$clubId/meeting/$meetingId"
								params={{ clubId, meetingId: item.meetingId }}
								aria-current={item.isCurrent ? "page" : undefined}
								className={cn(
```
with (spread the builder result, keep the other props):
```tsx
							<Link
								{...linkPropsFor(item.meetingId)}
								aria-current={item.isCurrent ? "page" : undefined}
								className={cn(
```
Leave the rest of the `<Link>` body (className branches, label, open-roles dot) unchanged.

- [ ] **Step 4: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS. The public club route (`club.$clubId.meeting.$meetingId.tsx`) still renders
`<MeetingNavStrip clubId={clubId} items={navItems} />` with no `getLinkProps` — the default
preserves its exact previous behavior.

**Fallback if the spread rejects (rare):** if `tsc` rejects `<Link {...linkPropsFor(...)}>`
because this router version won't accept a spread `LinkProps` union, cast the spread at the call
site only — `<Link {...(linkPropsFor(item.meetingId) as LinkProps)}>` — and if that still fails,
narrow the prop to `(meetingId: string) => { to: string; params: Record<string, string> }` and
render `<Link to={link.to as LinkProps["to"]} params={link.params as never}>`. Do not change the
two call sites' returned objects; they stay the same shape either way.

## Task 6: Render prev/next in `/meetings/$id`

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx` (imports, loader, header render)

- [ ] **Step 1: Add imports**

Add `listUpcomingMeetings` to the existing server import, and add the nav imports:
```tsx
import { getMeeting, listUpcomingMeetings, updateMeeting } from "#/server/meetings";
import { buildMeetingNavItems } from "#/lib/meeting-nav";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
```
(The first line replaces the current `import { getMeeting, updateMeeting } from "#/server/meetings";`.)

- [ ] **Step 2: Extend the loader to build nav items**

Replace the current loader:
```tsx
	loader: ({ params }) => getMeeting({ data: params.id }),
```
with:
```tsx
	loader: async ({ params }) => {
		const data = await getMeeting({ data: params.id });
		// Non-fatal: a failure here degrades to no strip, never blocks the page
		// (mirrors the public club route).
		const upcoming = await listUpcomingMeetings({
			data: data.meeting.clubId,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);
		const currentOpenSlots = data.slots.filter(
			(s) => s.status === "open",
		).length;
		const navItems = buildMeetingNavItems(
			{
				id: data.meeting.id,
				scheduledAt: data.meeting.scheduledAt,
				openSlots: currentOpenSlots,
			},
			upcoming,
			data.timezone,
		);
		return { ...data, navItems };
	},
```

- [ ] **Step 3: Destructure `navItems` in the component**

Find the loader-data destructure at the top of `MeetingDetail`:
```tsx
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		clubSlug,
		roster,
	} = Route.useLoaderData();
```
Add `navItems`:
```tsx
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		clubSlug,
		roster,
		navItems,
	} = Route.useLoaderData();
```

- [ ] **Step 4: Render the strip in the header**

Find the meeting meta block in the `<header>` (the date/location row) — it ends with this
closing `</div>` just before the Word-of-the-day paragraph:
```tsx
						{meeting.location ? (
							<span className="flex items-center gap-1.5">
								<MapPin className="size-4" aria-hidden />
								{meeting.location}
							</span>
						) : null}
					</div>
					{meeting.wordOfTheDay ? (
```
Insert the strip between that `</div>` and the Word-of-the-day block. The authed builder targets
`/meetings/$id` so paging stays in the workspace:
```tsx
						{meeting.location ? (
							<span className="flex items-center gap-1.5">
								<MapPin className="size-4" aria-hidden />
								{meeting.location}
							</span>
						) : null}
					</div>
					<MeetingNavStrip
						clubId={clubSlug}
						items={navItems}
						getLinkProps={(meetingId) => ({
							to: "/meetings/$id",
							params: { id: meetingId },
						})}
					/>
					{meeting.wordOfTheDay ? (
```

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS. If `to: "/meetings/$id"` errors, confirm the route id is `/_authed/meetings/$id`
and that the `to` path form is `/meetings/$id` with `params: { id }`.

- [ ] **Step 6: Run the nav-strip unit test again (regression)**

Run: `bunx vitest run src/lib/meeting-nav.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit (#142)**

```bash
git add src/lib/meeting-nav.ts src/lib/meeting-nav.test.ts src/components/club/meeting-nav-strip.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat: prev/next nav in signed-in meeting view (#142)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, and the new unit test**

Run:
```bash
bunx tsc --noEmit && bun run check && bunx vitest run src/lib/meeting-nav.test.ts
```
Expected: all PASS. Confirm `src/routeTree.gen.ts` is unmodified (`git status` shows it clean);
if not, `git checkout src/routeTree.gen.ts`.

- [ ] **Step 2: Live check via `/browse`**

Start the dev server (`bun run dev`, port 3000) signed in (use the dev-login route if needed),
then verify:
1. On `/meetings/$id` for a real meeting: a **Print agenda** and **Present** button appear;
   clicking each opens the correct public URL in a **new tab**
   (`/club/<slug>/meeting/<id>/print?layout=timing` and `/club/<slug>/meeting/<id>/present`).
2. On `/meetings/$id`, when the club has 2+ upcoming meetings, the **prev/next strip** appears
   and clicking another date navigates to `/meetings/<otherId>` — staying under `/meetings/`,
   **never** jumping to `/club/...`.
3. On `/agenda`: a **Present** button now appears next to **Print agenda**, and Present opens
   the projector deck for the next meeting in a new tab.

- [ ] **Step 3: Confirm the two-commit history**

Run: `git log --oneline main..HEAD`
Expected: two feature commits (Present/Print `#140`, then prev/next `#142`) on top of the spec
doc commits.

---

## Notes / gotchas for the executor

- **Escaped `$` in shell paths:** the `git add` commands escape `meetings.$id.tsx` as
  `meetings.\$id.tsx` so the shell doesn't treat `$id` as a variable.
- **Ungated by design:** `MeetingViewActions` takes no permission prop — Print/Present are
  read-only outputs shown to every signed-in member, matching the public club page. Do not add a
  `canManage` gate.
- **Do not touch the identity model or merge the meeting views** — that's #141 and explicitly out
  of scope here. `agenda.tsx` still reads `context.clubs[0]`; leave it.
- If the full test suite is run (`bun run test`), integration suites need `TEST_DATABASE_URL`
  set (see `CLAUDE.md`); the only new test here (`meeting-nav.test.ts`) is a pure unit test and
  needs no database.
