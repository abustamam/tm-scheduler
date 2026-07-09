# Meeting-View Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the separate signed-in `/agenda` screen into a single meeting view — `/meetings/$id` gains an at-a-glance stats strip, and `/agenda` becomes a `/next` shortcut that redirects to the next meeting (or shows an empty state).

**Architecture:** There is one signed-in meeting renderer (`/meetings/$id`). A new pure `summarizeAgenda(slots)` powers a stats strip added to it. `/agenda` is deleted and replaced by a thin `/next` resolver route whose loader redirects to `clubs[0]`'s next meeting. The sidebar entry is renamed "Next meeting" and every inbound `/agenda` link is repointed to `/next` (TypeScript's typed routes catch any missed).

**Tech Stack:** TanStack Start (React 19), TanStack Router (typed `<Link>` / `redirect`), shadcn/ui + Tailwind v4, Vitest, Biome. Package manager: **Bun**.

**Spec:** `docs/superpowers/specs/2026-07-09-meeting-view-consolidation-design.md` (issue #141; follow-on #145).

---

## Prerequisites — worktree setup (run once)

This plan executes in the `141-meeting-view-consolidation` worktree (`../tm-scheduler-141`). A fresh worktree has no `node_modules`/env.

- [ ] **Install deps + copy env**

Run from the worktree root:
```bash
bun install
cp ../tm-scheduler/.env.local .env.local
```
Expected: `bun install` completes; `.env.local` exists.

- [ ] **Baseline check**

Run: `bunx tsc --noEmit`
Expected: clean (green baseline before changes).

**Notes for the executor:**
- This plan **does** change the route set (removes `/agenda`, adds `/next`), so `src/routeTree.gen.ts` legitimately changes. Regenerate it with **`bun run generate-routes`** — never hand-edit it, and do NOT use `bun run build` to regenerate (build appends an extra SSR Register block).
- Biome formats with **tabs** + **double quotes**; run `bun run check` before each commit. Strict TS fails on unused symbols.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/agenda.ts` | Add pure `summarizeAgenda(slots)` | Modify |
| `src/lib/agenda.test.ts` | Unit-test `summarizeAgenda` | Modify |
| `src/routes/_authed/meetings.$id.tsx` | Single meeting view — add stats strip + "Remind unfilled" stub | Modify |
| `src/routes/_authed/next.tsx` | Resolver: redirect to next meeting, or empty state | **Create** |
| `src/routes/_authed/agenda.tsx` | (old dashboard screen) | **Delete** |
| `src/routes/_authed.tsx` | Sidebar item → "Next meeting"/`/next`; crumb | Modify |
| `src/routes/_authed/dashboard.tsx` | `/agenda` → `/next` (3 links + prop type) | Modify |
| `src/routes/_authed/index.tsx` | `/agenda` → `/next` (link + type) | Modify |
| `src/routes/_authed/members.$id.tsx` | `/agenda` → `/next` | Modify |
| `src/routeTree.gen.ts` | Regenerated | Generated |

**Commit grouping:** Task 1 (summarizeAgenda), Task 2 (stats strip), Task 3 (route collapse + link repoint — atomic), Task 4 (verify).

---

## Task 1: Add pure `summarizeAgenda` (TDD)

**Files:**
- Modify: `src/lib/agenda.ts`
- Test: `src/lib/agenda.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/agenda.test.ts`, add `summarizeAgenda` to the existing import from `./agenda`, then append this block at the end of the file:
```ts
describe("summarizeAgenda", () => {
	const slot = (
		assigneeId: string | null,
		status: string,
		isSpeakerRole = false,
	) => ({ assigneeId, status, isSpeakerRole });

	it("tallies fill, confirmed, and speaker counts with rounded percentage", () => {
		const summary = summarizeAgenda([
			slot("m1", "confirmed", true),
			slot("m2", "claimed", true),
			slot(null, "open", true),
			slot("m3", "confirmed"),
			slot(null, "open"),
		]);
		expect(summary).toEqual({
			total: 5,
			filled: 3,
			open: 2,
			pct: 60,
			confirmed: 2,
			speakerTotal: 3,
			speakerFilled: 2,
		});
	});

	it("returns 0% for no slots", () => {
		expect(summarizeAgenda([]).pct).toBe(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/agenda.test.ts`
Expected: FAIL — `summarizeAgenda` is not exported.

- [ ] **Step 3: Implement `summarizeAgenda`**

Append to `src/lib/agenda.ts`:
```ts
export type AgendaSummary = {
	total: number;
	filled: number;
	open: number;
	pct: number;
	confirmed: number;
	speakerTotal: number;
	speakerFilled: number;
};

/** At-a-glance counts for a meeting's slots: fill/confirm/speaker tallies and
 *  the filled percentage (0 when there are no slots). */
export function summarizeAgenda(
	slots: {
		assigneeId: string | null;
		status: string;
		isSpeakerRole: boolean;
	}[],
): AgendaSummary {
	const total = slots.length;
	const filled = slots.filter((s) => s.assigneeId).length;
	const confirmed = slots.filter((s) => s.status === "confirmed").length;
	const speakers = slots.filter((s) => s.isSpeakerRole);
	const speakerFilled = speakers.filter((s) => s.assigneeId).length;
	return {
		total,
		filled,
		open: total - filled,
		pct: total === 0 ? 0 : Math.round((filled / total) * 100),
		confirmed,
		speakerTotal: speakers.length,
		speakerFilled,
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/agenda.test.ts`
Expected: PASS (both new cases + all pre-existing agenda tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS.
```bash
git add src/lib/agenda.ts src/lib/agenda.test.ts
git commit -m "feat: add summarizeAgenda slot-summary helper (#141)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 2: Add the stats strip + "Remind unfilled" to `/meetings/$id`

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Import `summarizeAgenda`**

Change the existing agenda import:
```tsx
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
```
to:
```tsx
import { buildRoleCounts, slotLabel, summarizeAgenda } from "#/lib/agenda";
```

- [ ] **Step 2: Compute the summary**

Find, in the `MeetingDetail` component body:
```tsx
	// Number repeated roles ("Speaker 1", "Speaker 2", …).
	const roleCounts = buildRoleCounts(slots);
```
Add directly below it:
```tsx
	const summary = summarizeAgenda(slots);
```

- [ ] **Step 3: Render the stats strip after the header**

Find the end of the `<header>` block and the start of the unavailable-members section:
```tsx
			</header>

			{unavailableMembers.length > 0 ? (
```
Insert the stats strip between them:
```tsx
			</header>

			<section className="rounded-xl border bg-card p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
						<span>
							<span className="text-muted-foreground">Open roles: </span>
							<span className="font-semibold">
								{summary.open === 0 ? "All filled" : summary.open}
							</span>
						</span>
						<span>
							<span className="text-muted-foreground">Confirmed: </span>
							<span className="font-semibold">
								{summary.confirmed} of {summary.total}
							</span>
						</span>
						<span>
							<span className="text-muted-foreground">Prepared speeches: </span>
							<span className="font-semibold">
								{summary.speakerFilled} of {summary.speakerTotal}
							</span>
						</span>
					</div>
					{canManage ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								toast.info("Reminder sending isn't wired up yet.")
							}
						>
							Remind unfilled
						</Button>
					) : null}
				</div>
				<div className="mt-3">
					<div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
						<span>Roles filled</span>
						<span>{summary.pct}%</span>
					</div>
					<div className="h-2 overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary transition-[width]"
							style={{ width: `${summary.pct}%` }}
						/>
					</div>
				</div>
			</section>

			{unavailableMembers.length > 0 ? (
```

- [ ] **Step 4: Typecheck, lint, commit**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS. (`Button` and `toast` are already imported/used in this file.)
```bash
git add "src/routes/_authed/meetings.\$id.tsx"
git commit -m "feat: at-a-glance stats strip on the meeting view (#141)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 3: Replace `/agenda` with the `/next` resolver + repoint all links

This task is atomic — after it, `tsc` must be green (removing `/agenda` breaks every typed `to="/agenda"` until repointed).

**Files:**
- Create: `src/routes/_authed/next.tsx`
- Delete: `src/routes/_authed/agenda.tsx`
- Modify: `src/routes/_authed.tsx`, `src/routes/_authed/dashboard.tsx`, `src/routes/_authed/index.tsx`, `src/routes/_authed/members.$id.tsx`
- Generated: `src/routeTree.gen.ts`

- [ ] **Step 1: Create the `/next` resolver route**

Create `src/routes/_authed/next.tsx`:
```tsx
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CalendarPlus } from "lucide-react";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { getNextMeeting } from "#/server/meetings";

/**
 * Shortcut to the club's next meeting. Resolves `clubs[0]`'s soonest upcoming
 * meeting and redirects to its `/meetings/$id` page; when nothing is scheduled
 * (or the user has no club), renders the empty state instead. There is no
 * standalone "agenda" screen — a meeting IS its agenda (#141).
 */
export const Route = createFileRoute("/_authed/next")({
	loader: async ({ context }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) return { canManage: false };
		const data = await getNextMeeting({ data: clubId });
		if (data.meeting) {
			throw redirect({
				to: "/meetings/$id",
				params: { id: data.meeting.id },
			});
		}
		return { canManage: data.canManage };
	},
	component: NoUpcomingMeeting,
});

function NoUpcomingMeeting() {
	const { canManage } = Route.useLoaderData();
	return (
		<PageContainer>
			<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
				Next meeting
			</h1>
			<div className="mt-7 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface)] px-6 py-16 text-center">
				<p className="text-sm text-[var(--sea-ink-soft)]">
					No upcoming meeting is scheduled yet.
				</p>
				{canManage ? (
					<Button asChild size="sm" className="mt-4">
						<Link to="/admin/meetings/new">
							<CalendarPlus className="size-4" aria-hidden />
							Schedule a meeting
						</Link>
					</Button>
				) : null}
			</div>
		</PageContainer>
	);
}
```

- [ ] **Step 2: Delete the old agenda screen**

```bash
git rm src/routes/_authed/agenda.tsx
```

- [ ] **Step 3: Rename the sidebar entry + fix the breadcrumb**

In `src/routes/_authed.tsx`:

Change the nav item:
```tsx
					<NavItem to="/agenda" icon={CalendarDays} label="Agenda & roles" />
```
to:
```tsx
					<NavItem to="/next" icon={CalendarDays} label="Next meeting" />
```

Change the breadcrumb line:
```tsx
	if (pathname.startsWith("/agenda")) return "Manage · Agenda & roles";
```
to:
```tsx
	if (pathname.startsWith("/next")) return "Manage · Next meeting";
```

- [ ] **Step 4: Repoint `dashboard.tsx` links (3) + the prop type**

In `src/routes/_authed/dashboard.tsx`, change all three `to="/agenda"` occurrences to `to="/next"` (the "Browse the agenda" empty link, the per-commitment row `Link`, and the `QuickAction`), and change the `QuickAction` prop type:
```tsx
	to: "/agenda" | "/resources";
```
to:
```tsx
	to: "/next" | "/resources";
```

- [ ] **Step 5: Repoint `index.tsx` link + type**

In `src/routes/_authed/index.tsx`, change:
```tsx
			to: "/agenda" as const,
```
to:
```tsx
			to: "/next" as const,
```
and change the stat prop type:
```tsx
		to?: "/agenda";
```
to:
```tsx
		to?: "/next";
```

- [ ] **Step 6: Repoint `members.$id.tsx` link**

In `src/routes/_authed/members.$id.tsx`, change:
```tsx
						<Link to="/agenda">Assign a role</Link>
```
to:
```tsx
						<Link to="/next">Assign a role</Link>
```

- [ ] **Step 7: Regenerate the route tree**

Run: `bun run generate-routes`
Expected: `src/routeTree.gen.ts` updates — the `/agenda` route entries are gone and `/next` entries appear. (If it shows no change, confirm the create/delete landed.)

- [ ] **Step 8: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: PASS. If `tsc` reports a remaining `to="/agenda"`, that's a link this task missed — repoint it to `/next`. (This is the safety net: typed routes make a stale link a compile error.)

- [ ] **Step 9: Commit**

```bash
git add src/routes/_authed/next.tsx src/routes/_authed.tsx src/routes/_authed/dashboard.tsx src/routes/_authed/index.tsx "src/routes/_authed/members.\$id.tsx" src/routeTree.gen.ts
git commit -m "feat: collapse /agenda into a /next redirect to the meeting view (#141)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, tests**

Run:
```bash
bunx tsc --noEmit && bun run check && bunx vitest run src/lib/agenda.test.ts
```
Expected: all PASS. Confirm `git status` is clean (no stray `routeTree.gen.ts` diff beyond the committed regeneration).

- [ ] **Step 2: Live check via `/browse`**

Start the dev server (`bun run dev`, port 3000) signed in (use the dev-login route if needed), then verify:
1. The sidebar now reads **"Next meeting"**; clicking it lands on `/meetings/<id>` (the club's next meeting) — the URL is the meeting page, not `/next`.
2. `/meetings/$id` shows the **stats strip** (open roles / confirmed / prepared speeches + roles-filled % bar); as an officer, the **"Remind unfilled"** button appears and toasts the not-wired-up message.
3. Every former agenda entry point lands correctly: Dashboard "Sign up for a meeting role" and the "My upcoming roles" links, the roster/index "Open roles → next meeting" stat, and the member profile "Assign a role" button all navigate to the next meeting.
4. Empty-state: with no upcoming meeting scheduled, `/next` shows "No upcoming meeting is scheduled yet" (and the officer "Schedule a meeting" CTA) instead of redirecting.

- [ ] **Step 3: Confirm the commit history**

Run: `git log --oneline main..HEAD`
Expected: the spec/plan doc commits plus three feature commits (summarizeAgenda `#141`, stats strip `#141`, `/next` collapse `#141`).

---

## Notes / gotchas for the executor

- **Escaped `$` in shell paths:** `git add` for `meetings.$id.tsx` / `members.$id.tsx` escapes the `$` as `\$` so the shell doesn't treat `$id` as a variable.
- **Typed routes are the safety net:** every inbound `to="/agenda"` is a typed literal, so `tsc` will flag any this plan missed after the route is removed — don't skip the Task 3 Step 8 typecheck.
- **Out of scope (do NOT touch):** the public view `club.$clubId.meeting.$meetingId.tsx` (that's #145), the identity model, multi-club resolution (`/next` stays `clubs[0]`), and wiring up reminders (the button stays a stub).
- If the full suite is run (`bun run test`), integration suites need `TEST_DATABASE_URL` (see `CLAUDE.md`); the only new test here (`summarizeAgenda`) is a pure unit test needing no DB.
