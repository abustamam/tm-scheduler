# Pathways Progress UI (Plan 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the count-based Pathways progress (from Plan 1a) in the UI: an admin paste-box ingest screen, and the member "my progress" view + member-detail tab + roster column + dashboard tile — all reading a shared view model.

**Architecture:** A pure view-model builder turns Plan 1a's synced rows (`path_enrollments` + `path_level_progress`) into a per-path display model (ring %, current level, level chips with `approved`, "N of M"). A read server-fn exposes it for (a) the signed-in user's own person and (b) a given roster member. A shared `<PathwaysProgress>` React component renders the locked Option-B layout (count form — no named projects; that's Phase 2). Routes follow the repo's `createFileRoute` loader + inline-server-fn pattern.

**Tech Stack:** TanStack Start (`createServerFn`, file routes, loaders), React 19, shadcn/ui + Tailwind v4, lucide-react, Vitest, Biome (tabs + double quotes). Bun.

**Prerequisite:** Plan 1a merged (or on this branch): `pathwaysPaths`, `pathEnrollments`, `pathLevelProgress`, `people.basecampUserId`, `ingestPathwaysProgress` server-fn, and `syncClubProgress` all exist.

**Spec:** `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md`. **Deferred to Phase 2 (needs #101):** named "Your wins" / "Up next" — 1b is count-only.

> **Design note (locked in brainstorming):** Option-B layout — a ring for whole-path %, level chips showing `approved`, and for the current level a plain "Level N · X of Y" bar. Multi-path = a tab switcher (hidden with one path). No apologetic "which was it?" copy. Colors map to shadcn/Tailwind tokens; verify contrast in light + dark.

---

## File Structure

- **Create** `src/server/pathways-read-logic.ts` — pure-ish view-model builder + DB read (`pathwaysForPerson`, `buildPathViewModel`). `-logic.ts` (imports `#/db`), never imported by client.
- **Create** `src/server/pathways-read-logic.test.ts` — unit tests for the pure `buildPathViewModel` (ring %, current level, `completed > total`, all-approved).
- **Create** `src/server/pathways-read.integration.test.ts` — DB test for `pathwaysForPerson`.
- **Create** `src/server/pathways-read.ts` — read server-fns (`getMyPathways`, `getMemberPathways`). Exports only createServerFns + types.
- **Create** `src/components/pathways/pathways-progress.tsx` — shared `<PathwaysProgress paths={…} />` (ring + level chips + current-level bar + multi-path tabs).
- **Create** `src/routes/_authed/admin/pathways-sync.tsx` — admin paste-box ingest screen (calls `ingestPathwaysProgress`, shows matched/unmatched report + instructions).
- **Modify** `src/routes/_authed/members.$id.tsx` — add a Pathways section (calls `getMemberPathways`).
- **Modify** `src/routes/_authed/dashboard.tsx` — add a Pathways tile for the signed-in user (calls `getMyPathways`).
- **Modify** the roster list (found in Task 6) — add a compact Pathway/level column.
- Possibly **add** shadcn `tabs` (`bunx shadcn@latest add tabs`) if the multi-path switcher needs it; otherwise a minimal local toggle.

---

## Task 1: View-model builder (pure) + unit tests

**Files:** Create `src/server/pathways-read-logic.ts`, `src/server/pathways-read-logic.test.ts`.

The view model is what every surface renders. Keep the *pure* builder separate from the DB read so it's unit-testable.

- [ ] **Step 1: Write the failing unit test** (`pathways-read-logic.test.ts`):

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

import { buildPathViewModel, type SyncedLevel } from "./pathways-read-logic";

const lv = (level: number, completed: number, total: number, approved: boolean): SyncedLevel => ({
	level,
	completed,
	total,
	approved,
});

describe("buildPathViewModel", () => {
	it("computes ring %, current level, and per-level chips", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 2, 4, false), lv(3, 0, 4, false)],
		});
		expect(vm.pathName).toBe("Presentation Mastery");
		// completed capped at total per level: (5 + 2 + 0) / (5 + 4 + 4) = 7/13
		expect(vm.ringPercent).toBe(54);
		expect(vm.currentLevel).toBe(2); // lowest not-approved
		expect(vm.levels).toHaveLength(3);
		expect(vm.levels[0]).toEqual({ level: 1, completed: 5, total: 5, approved: true });
	});

	it("caps completed>total in the ring and reports the current-level counts", () => {
		const vm = buildPathViewModel({
			courseCode: "8705",
			pathName: "Strategic Relationships",
			levels: [lv(1, 5, 5, true), lv(2, 3, 3, true), lv(3, 7, 3, true), lv(4, 0, 2, false)],
		});
		// min(completed,total): (5+3+3+0)/(5+3+3+2)=11/13=85
		expect(vm.ringPercent).toBe(85);
		expect(vm.currentLevel).toBe(4);
	});

	it("marks a fully-approved path complete (no current level)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 4, 4, true)],
		});
		expect(vm.ringPercent).toBe(100);
		expect(vm.currentLevel).toBeNull();
		expect(vm.complete).toBe(true);
	});
});
```

- [ ] **Step 2: Run → fail** — `bunx vitest run src/server/pathways-read-logic.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`pathways-read-logic.ts`):

```ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";

export interface SyncedLevel {
	level: number;
	completed: number;
	total: number;
	approved: boolean;
}

export interface PathViewModel {
	courseCode: string;
	pathName: string;
	ringPercent: number; // 0–100, integer
	currentLevel: number | null; // lowest not-approved level; null when complete
	complete: boolean;
	levels: SyncedLevel[];
}

interface SyncedPath {
	courseCode: string;
	pathName: string;
	levels: SyncedLevel[];
}

/** Pure: shape one synced path into its display model. */
export function buildPathViewModel(path: SyncedPath): PathViewModel {
	const levels = [...path.levels].sort((a, b) => a.level - b.level);
	const done = levels.reduce((s, l) => s + Math.min(l.completed, l.total), 0);
	const total = levels.reduce((s, l) => s + l.total, 0);
	const ringPercent = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
	const firstUnapproved = levels.find((l) => !l.approved);
	return {
		courseCode: path.courseCode,
		pathName: path.pathName,
		ringPercent,
		currentLevel: firstUnapproved ? firstUnapproved.level : null,
		complete: !firstUnapproved,
		levels,
	};
}

/** Read every enrolled path for a person and build view models. */
export async function pathwaysForPerson(personId: string): Promise<PathViewModel[]> {
	const rows = await db
		.select({
			courseCode: pathwaysPaths.courseCode,
			pathName: pathwaysPaths.name,
			level: pathLevelProgress.level,
			completed: pathLevelProgress.completed,
			total: pathLevelProgress.total,
			approved: pathLevelProgress.approved,
		})
		.from(pathEnrollments)
		.innerJoin(pathwaysPaths, eq(pathEnrollments.pathId, pathwaysPaths.id))
		.innerJoin(
			pathLevelProgress,
			eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
		)
		.where(eq(pathEnrollments.personId, personId))
		.orderBy(asc(pathwaysPaths.sortOrder), asc(pathLevelProgress.level));

	const byPath = new Map<string, SyncedPath>();
	for (const r of rows) {
		let p = byPath.get(r.courseCode);
		if (!p) {
			p = { courseCode: r.courseCode, pathName: r.pathName, levels: [] };
			byPath.set(r.courseCode, p);
		}
		p.levels.push({ level: r.level, completed: r.completed, total: r.total, approved: r.approved });
	}
	return [...byPath.values()].map(buildPathViewModel);
}

/** Resolve the person for a roster member, then their paths. */
export async function pathwaysForMember(
	clubId: string,
	memberId: string,
): Promise<PathViewModel[]> {
	const { members } = await import("#/db/schema");
	const [m] = await db
		.select({ personId: members.personId })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)));
	if (!m) return [];
	return pathwaysForPerson(m.personId);
}

/** Resolve the person for a signed-in user (people.userId link), then their paths. */
export async function pathwaysForUser(userId: string): Promise<PathViewModel[]> {
	const [p] = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.userId, userId));
	if (!p) return [];
	return pathwaysForPerson(p.id);
}
```

- [ ] **Step 4: Run → pass** — `bunx vitest run src/server/pathways-read-logic.test.ts` → PASS.
- [ ] **Step 5: `bun run check` clean; commit** `feat(pathways): view-model builder + person reads`.

---

## Task 2: `pathwaysForPerson` integration test

**Files:** Create `src/server/pathways-read.integration.test.ts`.

- [ ] **Step 1: Failing integration test** — seed (via the same pattern as `pathways-sync.integration.test.ts`: a club, a person + `members` row) a person, insert a `pathwaysPaths` row, a `pathEnrollments` row, and two `pathLevelProgress` rows; assert `pathwaysForPerson(personId)` returns one `PathViewModel` with the right `ringPercent`/`currentLevel`/`levels`. Add a case: a person with two enrolled paths → two view models. Use `describe.skipIf(!hasTestDb)`, the local-cleanup approach from `pathways-sync.integration.test.ts` (wipe the 3 pathways tables wholesale + scoped `members`/`people`/club delete).

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-read.integration.test.ts` → FAIL then PASS after Task 1's `pathwaysForPerson` is in place (it already is — this task only adds the test).

- [ ] **Step 2–3: Verify pass, `bun run check`, commit** `test(pathways): pathwaysForPerson integration`.

---

## Task 3: Read server-fns

**Files:** Create `src/server/pathways-read.ts` (exports only createServerFns + types).

- [ ] **Step 1: Implement** — two GET server-fns following `src/server/members.ts` conventions:

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./guards";
import {
	type PathViewModel,
	pathwaysForMember,
	pathwaysForUser,
} from "./pathways-read-logic";

/** The signed-in user's own paths (dashboard tile / "my progress"). */
export const getMyPathways = createServerFn({ method: "GET" }).handler(
	async (): Promise<PathViewModel[]> => {
		const user = await requireUser();
		return pathwaysForUser(user.id);
	},
);

const memberSchema = z.object({ clubId: z.string().uuid(), memberId: z.string().uuid() });

/** A roster member's paths (member-detail tab). PUBLIC read (roster is auth-decoupled). */
export const getMemberPathways = createServerFn({ method: "GET" })
	.validator((i: unknown) => memberSchema.parse(i))
	.handler(async ({ data }): Promise<PathViewModel[]> => {
		return pathwaysForMember(data.clubId, data.memberId);
	});
```

- [ ] **Step 2:** `bunx vitest run src/server/server-modules.guard.test.ts` passes; `bunx tsc --noEmit` clean.
- [ ] **Step 3: Commit** `feat(pathways): read server-fns (my/member paths)`.

---

## Task 4: Shared `<PathwaysProgress>` component

**Files:** Create `src/components/pathways/pathways-progress.tsx`. Optionally `bunx shadcn@latest add tabs` if used.

- [ ] **Step 1: Build the component** rendering `PathViewModel[]` in the locked Option-B count form:
  - If `paths.length === 0`: a muted empty state ("No Pathways synced yet.").
  - If `paths.length > 1`: a tab switcher across path names (shadcn `tabs` or a minimal button toggle); one path → no switcher.
  - Per path: a **ring** (inline SVG `<circle>` with `stroke-dasharray` for `ringPercent`, center label `NN%`); **level chips** (one per level: approved → filled/`primary`, current → outline-accent, upcoming → muted-border) using shadcn `Badge`; and for `currentLevel`, a **"Level N · X of Y"** bar (a div track + filled div, widths from completed/total). Use design tokens (`bg-primary`, `text-muted-foreground`, `border`) — verify light + dark contrast.
  - Complete path (`complete`): show a "Path complete 🎉" flourish instead of a current-level bar.
  - No project names, no "which was it?" copy (Phase 2).
- [ ] **Step 2: Verify visually** — wire it into a scratch render or the dashboard tile (Task 5) and view via the dev server (`bun run dev`, then the /browse skill or a screenshot) with a seeded path. Confirm ring + chips + bar read correctly in both themes.
- [ ] **Step 3:** `bun run check` clean; commit `feat(pathways): shared PathwaysProgress component (count form)`.

---

## Task 5: Admin ingest screen

**Files:** Create `src/routes/_authed/admin/pathways-sync.tsx`.

- [ ] **Step 1: Build the route** mirroring `src/routes/_authed/admin/roles.tsx`:
  - `beforeLoad`: same admin/vpe guard (find an admin club in `context.clubs`, else `redirect({ to: "/" })`), return `adminClub`.
  - Component: step-by-step **instructions** (open Base Camp Manager → Paths Progress; capture each page's `/api/bcm/progress` JSON; paste all pages, or an array of pages), a `<textarea>` (reuse the `textareaClass` string from roles.tsx), and a "Sync" button.
  - On submit: `await ingestPathwaysProgress({ data: { clubId: adminClub.clubId, json } })`; show the returned `SyncResult` — `matched` / `pathsUpserted` counts and an **unmatched report** (list `name` + `email`, with copy "add them to the roster and re-sync"). `toast.error` on thrown errors (invalid/wrong-shape JSON messages come through). Clear/keep the textarea sensibly.
- [ ] **Step 2: Verify** via dev server: paste the `samples/_api_bcm_progress_1` contents (as an array with page 2) for the seeded club; confirm matched count + unmatched list render. (Local e2e can use the dev-login route.)
- [ ] **Step 3:** `bun run check` clean; commit `feat(pathways): admin ingest screen for Base Camp progress`.

---

## Task 6: Member-detail Pathways section, dashboard tile, roster column

**Files:** Modify `src/routes/_authed/members.$id.tsx`, `src/routes/_authed/dashboard.tsx`, and the roster list route (find it: `grep -rl "getMemberProfile\|listMembers\|roster" src/routes/_authed` — likely `index.tsx`).

- [ ] **Step 1: Member-detail** — in the `members.$id` loader, also call `getMemberPathways({ data: { clubId, memberId: params.id } })`; render `<PathwaysProgress paths={...} />` in a "Pathways" section of the member detail. `bun run check`; commit.
- [ ] **Step 2: Dashboard tile** — in `dashboard.tsx` loader add `getMyPathways()`; render a compact tile (the first path's ring + current-level line, linking to fuller detail). Handle the empty case. `bun run check`; commit.
- [ ] **Step 3: Roster column** — in the roster list, for each member show a compact Pathway + level label (e.g. "Presentation Mastery · L3 2/3" or a mini ring). To avoid N calls, extend the roster's loader to batch pathways (add a `listClubMemberPathways({ clubId })` logic fn that returns a `Map<memberId, PathViewModel[]>` in one query, wrapped by a server-fn) — mirror the batch pattern in `currentOfficersByMember`. `bun run check`; commit.
- [ ] **Step 4: Full verification** — `TEST_DATABASE_URL=… bun run test` all green; `bunx tsc --noEmit` clean; dev-server smoke of member-detail + dashboard + roster with seeded data (both themes). Commit any fixups.

---

## Self-Review

- **Spec coverage:** ingest screen (Task 5), member "my progress"/dashboard tile (Task 6.2 + component), member-detail tab (Task 6.1), roster column (Task 6.3) — all count-form. View model (Task 1) enforces ring cap + current-level = lowest-unapproved. ✓
- **Deferred correctly:** named projects / "Your wins" / "Up next" are Phase 2 (#101) — not in this plan. ✓
- **Placeholder scan:** UI Tasks 4–6 specify exact files, data sources, and layout; the roster location is resolved by an explicit grep in Task 6. No TODOs.
- **Bundle-leak discipline:** all `#/db` reads live in `pathways-read-logic.ts`; `pathways-read.ts` exports only createServerFns/types (guard test covers it).
- **Type consistency:** `PathViewModel` is produced by Task 1, exposed by Task 3, consumed by Tasks 4–6 unchanged.

## Subsequent
- **Phase 2 (needs #101):** add `pathways_projects` names → "Your wins" (from `speeches.project_id`) + named "Up next" in `<PathwaysProgress>`.
- **#107:** browser extension automating the Task 5 ingest endpoint.
