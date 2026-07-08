# Pathways /detail UI switchover (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the member Pathways view read the authoritative `bcm_project_progress` mirror for wins, up-next, and speech titles/dates, falling back to today's inference when an enrollment has no detail rows.

**Architecture:** Read-side only. The pure `buildPathViewModel` gains a bcm branch (taken when a path has `bcm_project_progress` rows); ring/levels/currentLevel/complete stay sourced from the count mirror (`path_level_progress`). Two new batched DB fetches feed `SyncedPath`; the member-view component gains a "Choose N more electives" group. No schema changes (Slice 1 delivered them).

**Tech Stack:** Drizzle ORM (node-postgres), Vitest (+ `tm_test` integration DB, jsdom for the component test), React 19, shadcn/ui + Tailwind, Biome (tabs, double quotes).

**Spec:** `docs/superpowers/specs/2026-07-08-pathways-detail-ui-design.md`

**Conventions:** import alias `#/*` → `src/*`; DB logic stays in `pathways-read-logic.ts` (a `-logic.ts`, never client-imported); integration suites gate `describe.skipIf(!hasTestDb)` and run with `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run <path>`; component tests set `// @vitest-environment jsdom`; `bun run check` before each commit (ignore the ~68 pre-existing warnings in unrelated files — keep YOUR files clean).

---

## File Structure

- Modify: `src/server/pathways-read-logic.ts` — new types (`DetailProjectRow`, `UpNextElectives`), `Win.deliveredAt` nullable, `PathViewModel.upNextElectives`, `SyncedPath.detailProjects`/`pathLevels`, the `buildPathViewModel` bcm branch (Task 1); the `fetchDetailProjects`/`fetchPathLevels` batches + threading into `pathwaysForPerson`/`pathwaysByMember` (Task 2).
- Modify: `src/server/pathways-read-logic.test.ts` — unit tests for the bcm branch (Task 1).
- Modify: `src/server/pathways-read.integration.test.ts` — bcm-sourced vs fallback integration (Task 2).
- Modify: `src/components/pathways/pathways-progress.tsx` — `UpNext` electives group (Task 3).
- Create: `src/components/pathways/pathways-progress.test.tsx` — component test (Task 3).

---

## Task 1: Pure `buildPathViewModel` bcm branch + types

**Files:**
- Modify: `src/server/pathways-read-logic.ts`
- Test: `src/server/pathways-read-logic.test.ts`

- [ ] **Step 1: Write failing unit tests for the bcm branch.**

Add to `src/server/pathways-read-logic.test.ts` (inside the existing `describe("buildPathViewModel", …)`), a nested block. It uses a `detailProjects` helper — add these helpers near the top-level `win`/`project` helpers:

```ts
import type { DetailProjectRow } from "./pathways-read-logic";

const dp = (
	level: number,
	name: string,
	complete: boolean,
	isRequired = true,
	speechTitle: string | null = null,
	speechDate: Date | null = null,
): DetailProjectRow => ({
	courseCode: "8701",
	level,
	name,
	isRequired,
	complete,
	speechTitle,
	speechDate,
});
```

Then the tests:

```ts
describe("bcm branch (detailProjects present)", () => {
	it("wins = all complete projects; speeches enriched, non-speech name-only", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 1, 4, false)],
			wins: [], // inference source ignored on the bcm branch
			catalogProjects: [],
			detailProjects: [
				dp(1, "Ice Breaker", true, true, "My Journey", new Date("2025-02-27T08:00:00Z")),
				dp(1, "Manage Projects Successfully", true, true), // leadership, no speech
				dp(2, "Researching a Topic", false, true), // not complete → not a win
			],
			pathLevels: [],
		});
		expect(vm.wins.map((w) => w.name)).toEqual([
			"Ice Breaker",
			"Manage Projects Successfully",
		]);
		const ice = vm.wins.find((w) => w.name === "Ice Breaker");
		expect(ice?.speechTitle).toBe("My Journey");
		expect(ice?.deliveredAt).toEqual(new Date("2025-02-27T08:00:00Z"));
		const leadership = vm.wins.find((w) => w.name === "Manage Projects Successfully");
		expect(leadership?.speechTitle).toBe("");
		expect(leadership?.deliveredAt).toBeNull();
	});

	it("upNext = current-level REQUIRED projects not complete; electives grouped", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(3, 1, 4, false)], // current level = 3
			wins: [],
			catalogProjects: [
				project(3, "Deliver Social Speeches", false), // elective, complete below
				project(3, "Persuasive Speaking", false), // elective, remaining
				project(3, "Connect with Storytelling", false), // elective, remaining
				project(3, "Understanding Emotional Intelligence", true), // required, remaining
			],
			detailProjects: [
				dp(3, "Deliver Social Speeches", true, false), // one elective done
			],
			pathLevels: [{ level: 3, minReqElectives: 2 }],
		});
		// required, not complete → individual
		expect(vm.upNext.map((p) => p.name)).toEqual([
			"Understanding Emotional Intelligence",
		]);
		// electives: need 2, 1 done → choose 1 more; options = remaining electives
		expect(vm.upNextElectives).toEqual({
			chooseCount: 1,
			options: ["Persuasive Speaking", "Connect with Storytelling"],
		});
	});

	it("no elective group when the level's elective requirement is already met", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 1, 4, false)],
			wins: [],
			catalogProjects: [project(1, "Elective A", false), project(1, "Elective B", false)],
			detailProjects: [dp(1, "Elective A", true, false), dp(1, "Elective B", true, false)],
			pathLevels: [{ level: 1, minReqElectives: 1 }], // need 1, 2 done
		});
		expect(vm.upNextElectives).toBeNull();
	});
});

it("fallback branch (no detailProjects) sets upNextElectives null and keeps inference wins", () => {
	const vm = buildPathViewModel({
		courseCode: "8701",
		pathName: "Presentation Mastery",
		levels: [lv(1, 1, 4, false)],
		wins: [win(1, "Ice Breaker")],
		catalogProjects: [project(1, "Ice Breaker"), project(1, "Speaking to Inform")],
		// no detailProjects
	});
	expect(vm.upNextElectives).toBeNull();
	expect(vm.wins.map((w) => w.name)).toEqual(["Ice Breaker"]); // inference passthrough
	expect(vm.upNext.map((p) => p.name)).toEqual(["Speaking to Inform"]); // today's logic
});
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `bunx vitest run src/server/pathways-read-logic.test.ts`
Expected: FAIL — `DetailProjectRow` not exported / `upNextElectives` undefined.

- [ ] **Step 3: Add the types.** In `src/server/pathways-read-logic.ts`, change `Win.deliveredAt` to nullable and add the new types + `SyncedPath`/`PathViewModel` fields.

Change the `Win` interface's `deliveredAt`:

```ts
export interface Win {
	level: number;
	name: string;
	speechTitle: string;
	deliveredAt: Date | null; // null for a non-speech (leadership) completion from /detail
}
```

Add after the `UpNextProject` interface:

```ts
/** Grouped elective choice for the current level (from the /detail mirror). */
export interface UpNextElectives {
	chooseCount: number; // min_req_electives − electives already complete at this level
	options: string[]; // remaining (not-complete) elective project names in the pool
}

/** One /detail mirror row joined to its catalog project. */
export interface DetailProjectRow {
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}
```

Add `upNextElectives` to `PathViewModel` (after `upNext`):

```ts
	/** Current-level elective choice, when the mirror is present and the level's
	 * elective requirement isn't met yet. Null on the inference fallback path. */
	upNextElectives: UpNextElectives | null;
```

Add to `SyncedPath` (after `catalogProjects`):

```ts
	/** /detail mirror rows for this path, when synced. Presence selects the bcm branch. */
	detailProjects?: DetailProjectRow[];
	/** Per-level elective requirements (pathways_path_levels), when synced. */
	pathLevels?: { level: number; minReqElectives: number }[];
```

- [ ] **Step 4: Add the bcm branch to `buildPathViewModel`.** Keep the ring/levels/currentLevel/complete computation exactly as-is, then branch before the current `upNext`/return. Replace the existing tail (from `// upNext = current-level catalog projects…` through the final `return { … }`) with:

```ts
	// The mirror augments: ring/levels/currentLevel/complete stay from the count
	// mirror above. Wins + up-next switch to /detail when this path has mirror rows.
	const detail = path.detailProjects;
	if (detail && detail.length > 0) {
		const wins: Win[] = detail
			.filter((p) => p.complete)
			.map((p) => ({
				level: p.level,
				name: p.name,
				speechTitle: p.speechTitle ?? "",
				deliveredAt: p.speechDate ?? null,
			}))
			.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

		let upNext: UpNextProject[] = [];
		let upNextElectives: UpNextElectives | null = null;
		if (!complete && currentLevel !== null) {
			const completeNames = new Set(
				detail.filter((p) => p.complete).map((p) => p.name),
			);
			const currentCatalog = path.catalogProjects.filter(
				(c) => c.level === currentLevel,
			);
			upNext = currentCatalog
				.filter((c) => c.isRequired && !completeNames.has(c.name))
				.map((c) => ({ level: c.level, name: c.name, isRequired: true }));

			const currentElectives = currentCatalog.filter((c) => !c.isRequired);
			const completedElectives = currentElectives.filter((c) =>
				completeNames.has(c.name),
			).length;
			const minReq =
				path.pathLevels?.find((l) => l.level === currentLevel)?.minReqElectives ??
				0;
			const chooseCount = Math.max(0, minReq - completedElectives);
			if (chooseCount > 0) {
				upNextElectives = {
					chooseCount,
					options: currentElectives
						.filter((c) => !completeNames.has(c.name))
						.map((c) => c.name),
				};
			}
		}

		return {
			courseCode: path.courseCode,
			pathName: path.pathName,
			ringPercent,
			currentLevel,
			complete,
			levels,
			wins,
			upNext,
			upNextElectives,
		};
	}

	// Inference fallback (unchanged): wins from the member's own delivered
	// speeches, up-next = current-level catalog minus win-names.
	const winNames = new Set(path.wins.map((w) => w.name));
	const upNext =
		complete || currentLevel === null
			? []
			: path.catalogProjects
					.filter((cp) => cp.level === currentLevel && !winNames.has(cp.name))
					.map((cp) => ({
						level: cp.level,
						name: cp.name,
						isRequired: cp.isRequired,
					}));

	return {
		courseCode: path.courseCode,
		pathName: path.pathName,
		ringPercent,
		currentLevel,
		complete,
		levels,
		wins: path.wins,
		upNext,
		upNextElectives: null,
	};
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `bunx vitest run src/server/pathways-read-logic.test.ts`
Expected: PASS — the new bcm-branch tests and the existing ones (which now also get `upNextElectives: null`, unasserted, so still green).

- [ ] **Step 6: Lint + commit.**

```bash
bun run check
git add src/server/pathways-read-logic.ts src/server/pathways-read-logic.test.ts
git commit -m "feat: buildPathViewModel bcm branch — authoritative wins/up-next from /detail mirror (#121)"
```

---

## Task 2: DB fetches + threading into the read entrypoints

**Files:**
- Modify: `src/server/pathways-read-logic.ts`
- Test: `src/server/pathways-read.integration.test.ts`

- [ ] **Step 1: Write the failing integration test.** The suite already has helpers: `makeMember(over?)` → `{ personId, memberId }`; `enrollInPath(personId, { courseCode, pathName })` → `{ pathId, enrollmentId }` (seeds path + enrollment + two `path_level_progress` rows: L1 approved, L2 not); and a suite-unique `code(base)` helper. Add `bcmProjectProgress` to the top-of-file `#/db/schema` import (`pathwaysProjects`, `pathEnrollments`, `pathwaysPaths` are already imported). Add these two tests inside the existing `describe`:

```ts
it("sources wins from the /detail mirror when bcm_project_progress rows exist", async () => {
	const { personId } = await makeMember({ email: `detail-1-${SUITE_TAG}@x.test` });
	const cc = code("8700");
	const { pathId, enrollmentId } = await enrollInPath(personId, {
		courseCode: cc,
		pathName: "Motivational Strategies",
	});
	const [proj] = await testDb
		.insert(pathwaysProjects)
		.values({ pathId, level: 1, name: "Ice Breaker", isRequired: true, bcmBlockId: `ib-${cc}` })
		.returning({ id: pathwaysProjects.id });
	await testDb.insert(bcmProjectProgress).values({
		enrollmentId,
		projectId: proj.id,
		complete: true,
		speechTitle: "My First Speech",
		speechDate: new Date("2025-03-01T08:00:00Z"),
	});

	const paths = await pathwaysForPerson(personId);
	const path = paths.find((p) => p.courseCode === cc);
	expect(
		path?.wins.some(
			(w) => w.name === "Ice Breaker" && w.speechTitle === "My First Speech",
		),
	).toBe(true);
});

it("falls back to inference (upNextElectives null) when no mirror rows exist", async () => {
	const { personId } = await makeMember({ email: `detail-2-${SUITE_TAG}@x.test` });
	const cc = code("8705");
	await enrollInPath(personId, { courseCode: cc, pathName: "Strategic Relationships" });
	const paths = await pathwaysForPerson(personId);
	const path = paths.find((p) => p.courseCode === cc);
	// No mirror rows and no delivered speeches → inference branch: upNextElectives null.
	expect(path?.upNextElectives).toBeNull();
});
```

> Cleanup: the suite's `afterEach`/`afterAll` scopes deletes to this suite's rows (suite-unique course codes). The seeded `pathwaysProjects` + `bcmProjectProgress` rows cascade when the suite deletes its `pathwaysPaths`/enrollments. If the existing cleanup only deletes paths by the suite tag, the catalog + mirror rows go with them (cascade). Confirm the suite's cleanup covers the new rows; if not, delete the seeded `pathwaysProjects` by `bcmBlockId like 'ib-%${SUITE_TAG}'` in the cleanup.

- [ ] **Step 2: Run to verify it fails.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-read.integration.test.ts`
Expected: FAIL — wins don't include the mirror-sourced "Ice Breaker" (fetch/threading not implemented).

- [ ] **Step 3: Add the two batched fetches.** In `src/server/pathways-read-logic.ts`, add `bcmProjectProgress` and `pathwaysPathLevels` to the `#/db/schema` import, then add these functions near `fetchCatalogProjects`:

```ts
interface DetailRow {
	personId: string;
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}

/** /detail mirror rows joined to catalog + path, keyed by person (via the
 * enrollment) — symmetric with `fetchDeliveredWins`, so both read paths group
 * by `personId::courseCode`. */
async function fetchDetailProjects(personIds: string[]): Promise<DetailRow[]> {
	if (personIds.length === 0) return [];
	return db
		.select({
			personId: pathEnrollments.personId,
			courseCode: pathwaysPaths.courseCode,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
			complete: bcmProjectProgress.complete,
			speechTitle: bcmProjectProgress.speechTitle,
			speechDate: bcmProjectProgress.speechDate,
		})
		.from(bcmProjectProgress)
		.innerJoin(
			pathEnrollments,
			eq(pathEnrollments.id, bcmProjectProgress.enrollmentId),
		)
		.innerJoin(
			pathwaysProjects,
			eq(pathwaysProjects.id, bcmProjectProgress.projectId),
		)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.where(inArray(pathEnrollments.personId, personIds));
}

/** Per-level elective requirements (pathways_path_levels) for a set of path ids. */
async function fetchPathLevels(
	pathIds: string[],
): Promise<{ courseCode: string; level: number; minReqElectives: number }[]> {
	if (pathIds.length === 0) return [];
	return db
		.select({
			courseCode: pathwaysPaths.courseCode,
			level: pathwaysPathLevels.level,
			minReqElectives: pathwaysPathLevels.minReqElectives,
		})
		.from(pathwaysPathLevels)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysPathLevels.pathId))
		.where(inArray(pathwaysPathLevels.pathId, pathIds));
}
```

- [ ] **Step 4: Thread the fetches into `pathwaysForPerson`.** No new columns needed — `fetchDetailProjects` takes the `personId` this function already has. Replace the existing `const [winRows, catalogRows] = await Promise.all([...])` with:

```ts
	const [winRows, catalogRows, detailRows, pathLevelRows] = await Promise.all([
		fetchDeliveredWins([personId], pathIds),
		fetchCatalogProjects(pathIds),
		fetchDetailProjects([personId]),
		fetchPathLevels(pathIds),
	]);
```

After the existing win/catalog attach loops, attach detail + path-levels by course code (`DetailRow.personId` is dropped here — a single person, so course code alone disambiguates):

```ts
	for (const d of detailRows) {
		const p = byPath.get(d.courseCode);
		if (!p) continue;
		(p.detailProjects ??= []).push({
			courseCode: d.courseCode,
			level: d.level,
			name: d.name,
			isRequired: d.isRequired,
			complete: d.complete,
			speechTitle: d.speechTitle,
			speechDate: d.speechDate,
		});
	}
	for (const pl of pathLevelRows) {
		const p = byPath.get(pl.courseCode);
		if (!p) continue;
		(p.pathLevels ??= []).push({ level: pl.level, minReqElectives: pl.minReqElectives });
	}
```

- [ ] **Step 5: Thread the same into `pathwaysByMember`.** It groups wins by `personId::courseCode` and catalog by `courseCode`; detail follows the wins pattern exactly (both are person-scoped), path-levels follow the catalog pattern (path-scoped). No select change needed — `personIds`/`pathIds` sets already exist.

Extend its existing `Promise.all` to fetch detail + path-levels:

```ts
	const [winRows, catalogRows, detailRows, pathLevelRows] = await Promise.all([
		fetchDeliveredWins([...personIds], [...pathIds]),
		fetchCatalogProjects([...pathIds]),
		fetchDetailProjects([...personIds]),
		fetchPathLevels([...pathIds]),
	]);
```

After the existing `winsByPersonAndPath` and `catalogByCourseCode` maps are built, add two more (mirroring them exactly):

```ts
	// Detail rows are person-scoped (like wins) → key by personId::courseCode.
	const detailByPersonAndPath = new Map<string, DetailProjectRow[]>();
	for (const d of detailRows) {
		const key = `${d.personId}::${d.courseCode}`;
		let list = detailByPersonAndPath.get(key);
		if (!list) {
			list = [];
			detailByPersonAndPath.set(key, list);
		}
		list.push({
			courseCode: d.courseCode,
			level: d.level,
			name: d.name,
			isRequired: d.isRequired,
			complete: d.complete,
			speechTitle: d.speechTitle,
			speechDate: d.speechDate,
		});
	}

	// Path-levels are path-scoped (like catalog) → key by courseCode.
	const pathLevelsByCourseCode = new Map<
		string,
		{ level: number; minReqElectives: number }[]
	>();
	for (const pl of pathLevelRows) {
		let list = pathLevelsByCourseCode.get(pl.courseCode);
		if (!list) {
			list = [];
			pathLevelsByCourseCode.set(pl.courseCode, list);
		}
		list.push({ level: pl.level, minReqElectives: pl.minReqElectives });
	}
```

Then, in the final per-member `map(...)` where it already sets `p.wins` and `p.catalogProjects`, add the two attaches before `buildPathViewModel(p)`:

```ts
			p.detailProjects = detailByPersonAndPath.get(`${personId}::${p.courseCode}`);
			p.pathLevels = pathLevelsByCourseCode.get(p.courseCode);
```

(Leaving `detailProjects` undefined when a member has no mirror rows is correct — `buildPathViewModel` then takes the inference branch. `DetailProjectRow` must be imported/exported; it's the type Task 1 added, so it's already exported from this file.)

- [ ] **Step 6: Run the integration tests to verify they pass.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-read.integration.test.ts`
Expected: PASS (mirror-sourced wins + fallback both verified).

- [ ] **Step 7: Run the read-logic unit tests + guard test (no regression).**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-read-logic.test.ts src/server/server-modules.guard.test.ts`
Expected: PASS.

- [ ] **Step 8: Lint + commit.**

```bash
bun run check
git add src/server/pathways-read-logic.ts src/server/pathways-read.integration.test.ts
git commit -m "feat: read /detail mirror in pathwaysForPerson/pathwaysByMember (batched, no N+1) (#121)"
```

---

## Task 3: Component — "Choose N more electives" group

The only component change: `UpNext` renders the elective group. (Non-speech wins already render cleanly through the existing `YourWins` — an empty `speechTitle` + null `deliveredAt` skips the subtitle, leaving trophy + name + level.)

**Files:**
- Modify: `src/components/pathways/pathways-progress.tsx`
- Test: `src/components/pathways/pathways-progress.test.tsx`

- [ ] **Step 1: Write the failing component test.** Create `src/components/pathways/pathways-progress.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PathViewModel } from "#/server/pathways-read-logic";
import { PathwaysProgress } from "./pathways-progress";

const base: PathViewModel = {
	courseCode: "8701",
	pathName: "Presentation Mastery",
	ringPercent: 40,
	currentLevel: 3,
	complete: false,
	levels: [
		{ level: 1, completed: 5, total: 5, approved: true },
		{ level: 3, completed: 1, total: 4, approved: false },
	],
	wins: [],
	upNext: [],
	upNextElectives: null,
};

describe("PathwaysProgress", () => {
	afterEach(() => cleanup());

	it("renders a 'Choose N more electives' group with the option names", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						upNext: [{ level: 3, name: "Understanding Emotional Intelligence", isRequired: true }],
						upNextElectives: { chooseCount: 1, options: ["Persuasive Speaking", "Connect with Storytelling"] },
					},
				]}
			/>,
		);
		expect(screen.getByText(/Choose 1 more elective/i)).toBeTruthy();
		expect(screen.getByText("Persuasive Speaking")).toBeTruthy();
		expect(screen.getByText("Understanding Emotional Intelligence")).toBeTruthy();
	});

	it("renders a non-speech win as a bare name (no crash on null date/empty title)", () => {
		render(
			<PathwaysProgress
				paths={[{ ...base, wins: [{ level: 1, name: "Manage Projects Successfully", speechTitle: "", deliveredAt: null }] }]}
			/>,
		);
		expect(screen.getByText("Manage Projects Successfully")).toBeTruthy();
	});

	it("shows no elective group when upNextElectives is null", () => {
		render(
			<PathwaysProgress
				paths={[{ ...base, upNext: [{ level: 3, name: "Speaking to Inform", isRequired: true }] }]}
			/>,
		);
		expect(screen.queryByText(/Choose .* elective/i)).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bunx vitest run src/components/pathways/pathways-progress.test.tsx`
Expected: FAIL — "Choose 1 more elective" text not found (the group isn't rendered yet).

- [ ] **Step 3: Update `UpNext` to render the elective group.** In `src/components/pathways/pathways-progress.tsx`, replace the `UpNext` function with:

```tsx
/** Named current-level catalog projects not yet won — the specific layer
 * beneath the count bar. Never phrased as a deficiency. Electives (from the
 * /detail mirror) collapse into a "choose N more" group. */
function UpNext({
	upNext,
	electives,
}: {
	upNext: PathViewModel["upNext"];
	electives: PathViewModel["upNextElectives"];
}) {
	if (upNext.length === 0 && !electives) return null;
	return (
		<div className="flex flex-col gap-2">
			<div className="font-medium text-foreground text-sm">Up next</div>
			{upNext.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{upNext.map((p) => (
						<Badge
							key={p.name}
							variant={p.isRequired ? "default" : "outline"}
							className={cn(!p.isRequired && "font-normal text-muted-foreground")}
						>
							{p.name}
							{p.isRequired && <span className="ml-1 opacity-80">Required</span>}
						</Badge>
					))}
				</div>
			)}
			{electives && (
				<div className="flex flex-col gap-1.5">
					<div className="text-muted-foreground text-xs">
						Choose {electives.chooseCount} more elective
						{electives.chooseCount === 1 ? "" : "s"}:
					</div>
					<div className="flex flex-wrap gap-1.5">
						{electives.options.map((name) => (
							<Badge
								key={name}
								variant="outline"
								className="font-normal text-muted-foreground"
							>
								{name}
							</Badge>
						))}
					</div>
				</div>
			)}
			<div className="text-muted-foreground text-xs">
				Do it in Base Camp — it'll sync here.
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Pass `upNextElectives` from `PathBlock`.** In the same file, find the line in `PathBlock`:

```tsx
			{!path.complete && <UpNext upNext={path.upNext} />}
```

Replace with:

```tsx
			{!path.complete && (
				<UpNext upNext={path.upNext} electives={path.upNextElectives} />
			)}
```

- [ ] **Step 5: Run to verify it passes.**

Run: `bunx vitest run src/components/pathways/pathways-progress.test.tsx`
Expected: PASS (all three cases).

- [ ] **Step 6: Lint + commit.**

```bash
bun run check
git add src/components/pathways/pathways-progress.tsx src/components/pathways/pathways-progress.test.tsx
git commit -m "feat: member view — 'Choose N more electives' group from /detail mirror (#121)"
```

---

## Final verification

- [ ] **Full check + test gate.**

Run: `bun run check` → 0 errors.
Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run` → all pass (new bcm-branch unit tests, read integration, component test).
Run: `bun run build` → clean (surfaces any TS errors).

---

## Definition of done (Slice 2)

- A member whose enrollment has `bcm_project_progress` rows sees wins sourced from the mirror
  (all completed projects; speeches show real title + date; leadership projects show name),
  up-next required projects that aren't complete, and a "choose N more electives" group driven by
  `min_req_electives`.
- A member with no mirror rows sees the unchanged inferred view (silent fallback, `upNextElectives` null).
- Ring / level chips / current-level bar are unchanged (still from the count mirror).
- No schema change.
