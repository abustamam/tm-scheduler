# Pathways `/detail` endpoint — Slice 1 (backend + extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync Base Camp's per-member `/detail` endpoint into a read-only mirror of authoritative per-project completion + speech titles/dates, end-to-end (schema → parser → ingest → extension fan-out), with no UI change yet.

**Architecture:** Augment the existing count-based mirror. The hand-seeded catalog stays the source of the elective *pool*; `/detail` stamps `bcm_block_id` onto matched catalog rows, derives required projects Base Camp knows that we didn't seed, and fills a new `bcm_project_progress` table. The extension fans out one `/detail` call per member×path after its summary walk and POSTs both to the existing `/api/pathways/ingest` endpoint (new optional `details` field, backward-compatible). Parsing is server-side on the raw payload, following the summary path's convention.

**Tech Stack:** Drizzle ORM (node-postgres), TanStack Start server route, Vitest (+ `tm_test` integration DB), WXT browser extension (TypeScript), Biome (tabs, double quotes).

**Spec:** `docs/superpowers/specs/2026-07-07-pathways-detail-endpoint-design.md`

**Conventions to honor throughout:**
- Import alias `#/*` → `src/*`.
- DB-touching logic lives in `*-logic.ts` siblings, never imported by client code (the `server-modules.guard.test.ts` bundle-leak guard). The pure parser in `src/lib/` may be imported anywhere.
- Biome formats with **tabs** and **double quotes**; run `bun run check` before each commit.
- Integration suites gate on `describe.skipIf(!hasTestDb)` and run with `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run <path>`.

---

## File Structure

**Server (new):**
- `src/lib/basecamp-detail.ts` — pure parser: raw `/detail` payload → flat `ParsedDetail`. No DB. Fixture-testable in isolation.
- `src/server/pathways-detail-logic.ts` — DB logic: catalog reconciliation + `bcm_project_progress` upsert. `-logic.ts` sibling (bundle guard).
- `src/lib/basecamp-detail.test.ts` — unit tests for the parser.
- `src/server/pathways-detail.integration.test.ts` — tm_test integration tests for the DB logic.

**Server (modified):**
- `src/db/schema.ts` — add `bcmBlockId` to `pathwaysProjects`; add `pathwaysPathLevels` + `bcmProjectProgress` tables + relations.
- `src/server/pathways-ingest-logic.ts` — accept optional `details`, parse + sync, merge result.

**Extension (new):**
- `extension/lib/basecamp-detail-walk.ts` — pure detail fan-out (bounded concurrency, graceful per-call failure) + a helper to extract targets from raw summary pages. Injectable fetch.
- `extension/lib/basecamp-detail-walk.test.ts` — unit tests.

**Extension (modified):**
- `extension/lib/messages.ts` — `IngestRequest.details`, `SyncResultLike.detail`.
- `extension/entrypoints/background.ts` — include `details` in the POST body.
- `extension/entrypoints/basecamp.content.ts` — after the summary walk, extract targets, fan out details, send both.

**Docs (new/modified):**
- `docs/adr/0011-basecamp-detail-project-completion.md` — the ADR.
- `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md` — superseding note appended.

---

## Task 1: Schema — `bcm_block_id`, `pathways_path_levels`, `bcm_project_progress`

**Files:**
- Modify: `src/db/schema.ts`
- Create (generated): `drizzle/XXXX_*.sql` via `bun run db:generate`

- [ ] **Step 1: Add `bcmBlockId` to `pathwaysProjects`.**

In `src/db/schema.ts`, inside the `pathwaysProjects` table definition, add the column after `isRequired` and add a unique index. The column is nullable (elective-pool rows no member has chosen yet have no block id) and unique-when-present:

```ts
	isRequired: boolean("is_required").notNull().default(false),
	// Base Camp block id (from /detail blocks). Stamped onto a catalog row when a
	// member's /detail reveals it; null for pool rows no member has chosen yet.
	// The durable join key for bcm_project_progress. Unique-when-present.
	bcmBlockId: text("bcm_block_id"),
	sortOrder: integer("sort_order").notNull().default(0),
```

And add to the table's index array (alongside the existing `pathways_projects_path_level_name_idx`):

```ts
	(t) => [
		uniqueIndex("pathways_projects_path_level_name_idx").on(
			t.pathId,
			t.level,
			t.name,
		),
		uniqueIndex("pathways_projects_bcm_block_id_idx")
			.on(t.bcmBlockId)
			.where(sql`${t.bcmBlockId} is not null`),
	],
```

Ensure `sql` is imported at the top of the file from `drizzle-orm` (it's already imported — the file uses `import { relations } from "drizzle-orm"`; change to also import `sql`):

```ts
import { relations, sql } from "drizzle-orm";
```

- [ ] **Step 2: Add the `pathwaysPathLevels` table.**

Add immediately after the `pathwaysProjects` table definition:

```ts
// Per-(path, level) chapter facts from /detail (spec 2026-07-07). Currently just
// `min_req_electives` — how many electives a level requires — which drives the
// precise "up next" elective count. One row per (path, level).
export const pathwaysPathLevels = pgTable(
	"pathways_path_levels",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		pathId: uuid("path_id")
			.notNull()
			.references(() => pathwaysPaths.id, { onDelete: "cascade" }),
		level: integer("level").notNull(),
		minReqElectives: integer("min_req_electives").notNull().default(0),
	},
	(t) => [
		uniqueIndex("pathways_path_levels_path_level_idx").on(t.pathId, t.level),
	],
);
```

- [ ] **Step 3: Add the `bcmProjectProgress` table.**

Add after `pathwaysPathLevels`:

```ts
// Read-only mirror of Base Camp /detail per-project completion + speech (spec
// 2026-07-07). One row per (enrollment, project). Re-derived every sync via
// replace-per-enrollment; enrollments absent from a sync keep last-known-good.
export const bcmProjectProgress = pgTable(
	"bcm_project_progress",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		enrollmentId: uuid("enrollment_id")
			.notNull()
			.references(() => pathEnrollments.id, { onDelete: "cascade" }),
		projectId: uuid("project_id")
			.notNull()
			.references(() => pathwaysProjects.id, { onDelete: "cascade" }),
		complete: boolean("complete").notNull(),
		speechTitle: text("speech_title"),
		speechDate: timestamp("speech_date", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("bcm_project_progress_enrollment_project_idx").on(
			t.enrollmentId,
			t.projectId,
		),
	],
);
```

- [ ] **Step 4: Add relations.**

Find the existing `pathwaysProjectsRelations` and `pathEnrollmentsRelations` blocks. Add a `bcmProjectProgress` relation table block after `bcmProjectProgress` is defined, and extend the two existing relation blocks. Add:

```ts
export const bcmProjectProgressRelations = relations(
	bcmProjectProgress,
	({ one }) => ({
		enrollment: one(pathEnrollments, {
			fields: [bcmProjectProgress.enrollmentId],
			references: [pathEnrollments.id],
		}),
		project: one(pathwaysProjects, {
			fields: [bcmProjectProgress.projectId],
			references: [pathwaysProjects.id],
		}),
	}),
);

export const pathwaysPathLevelsRelations = relations(
	pathwaysPathLevels,
	({ one }) => ({
		path: one(pathwaysPaths, {
			fields: [pathwaysPathLevels.pathId],
			references: [pathwaysPaths.id],
		}),
	}),
);
```

(No need to add `many(...)` back-relations unless a query needs them — YAGNI; the read side is Slice 2.)

- [ ] **Step 5: Generate the migration.**

Run: `bun run db:generate`
Expected: a new file `drizzle/XXXX_*.sql` is written containing `ALTER TABLE "pathways_projects" ADD COLUMN "bcm_block_id"`, `CREATE TABLE "pathways_path_levels"`, and `CREATE TABLE "bcm_project_progress"`. No errors.

- [ ] **Step 6: Apply the migration to the dev DB and verify it round-trips.**

Run: `bun run db:migrate`
Expected: applies cleanly, exits 0.

Then verify the generator sees no drift (CI does this):
Run: `bun run db:generate`
Expected: "No schema changes, nothing to migrate" (or equivalent no-op) — the schema matches the committed migration.

- [ ] **Step 7: Commit.**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): schema for Base Camp /detail mirror (bcm_project_progress, path_levels, bcm_block_id) (#120)"
```

---

## Task 2: Pure `/detail` parser (`src/lib/basecamp-detail.ts`)

Parses one raw `/detail` payload into a flat, DB-agnostic shape: the real projects (placeholders excluded), each with completion + optional speech, plus the per-level `min_req_electives`.

**Files:**
- Create: `src/lib/basecamp-detail.ts`
- Test: `src/lib/basecamp-detail.test.ts`

- [ ] **Step 1: Write the failing test with a scrubbed synthetic fixture.**

Create `src/lib/basecamp-detail.test.ts`. The fixture mirrors the structure documented in #120 — **synthetic values only, no real member PII**:

```ts
/**
 * Unit tests for the pure /detail parser. Synthetic fixture (no real PII).
 * Run: bunx vitest run src/lib/basecamp-detail.test.ts
 */
import { describe, expect, it } from "vitest";
import { type BcmDetailPayload, parseDetailPayload } from "./basecamp-detail";

const payload: BcmDetailPayload = {
	basecampUserId: "122747",
	courseId: "course-v1:Toastmasters+8700+8_15_2023",
	blocks: {
		type: "course",
		display_name: "Motivational Strategies",
		children: [
			{
				type: "chapter",
				display_name: "Level 1",
				complete: true,
				min_req_electives: 0,
				children: [
					{
						block_id: "b-ice",
						type: "sequential",
						display_name: "Ice Breaker",
						complete: true,
						block_lib_type: "imported",
					},
					{
						block_id: "b-purpose",
						type: "sequential",
						display_name: "Writing a Speech with Purpose",
						complete: true,
						block_lib_type: "imported",
					},
				],
			},
			{
				type: "chapter",
				display_name: "Level 3",
				complete: false,
				min_req_electives: 2,
				children: [
					{
						block_id: "b-social",
						type: "sequential",
						display_name: "Deliver Social Speeches",
						complete: true,
						block_lib_type: "elective",
					},
					{
						block_id: "",
						type: "sequential",
						display_name: "2nd Elective",
						block_lib_type: "elective",
					},
				],
			},
		],
	},
	speeches: {
		"b-ice": { speech_title: "My Journey Here", speech_date: "2025-02-27T08:00:00Z" },
	},
};

describe("parseDetailPayload", () => {
	it("flattens real projects with completion, joins speeches, excludes placeholders", () => {
		const parsed = parseDetailPayload(payload);
		expect(parsed.courseCode).toBe("8700");
		expect(parsed.basecampUserId).toBe("122747");

		// Placeholder ("2nd Elective", empty block_id) is excluded.
		expect(parsed.projects.map((p) => p.blockId)).toEqual([
			"b-ice",
			"b-purpose",
			"b-social",
		]);

		const ice = parsed.projects.find((p) => p.blockId === "b-ice");
		expect(ice).toMatchObject({
			name: "Ice Breaker",
			level: 1,
			isRequired: true,
			complete: true,
			speechTitle: "My Journey Here",
		});
		expect(ice?.speechDate?.toISOString()).toBe("2025-02-27T08:00:00.000Z");

		const social = parsed.projects.find((p) => p.blockId === "b-social");
		expect(social).toMatchObject({ isRequired: false, complete: true });
		expect(social?.speechTitle).toBeNull();

		// min_req_electives captured per level.
		expect(parsed.levels).toEqual([
			{ level: 1, minReqElectives: 0 },
			{ level: 3, minReqElectives: 2 },
		]);
	});

	it("treats a missing `complete` as false", () => {
		const parsed = parseDetailPayload(payload);
		// (all fixture projects have complete set; assert the coercion is boolean)
		for (const p of parsed.projects) expect(typeof p.complete).toBe("boolean");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bunx vitest run src/lib/basecamp-detail.test.ts`
Expected: FAIL — `Cannot find module './basecamp-detail'`.

- [ ] **Step 3: Implement the parser.**

Create `src/lib/basecamp-detail.ts`:

```ts
/**
 * Pure parser for Base Camp Manager's per-member /detail endpoint
 * (`GET /api/bcm/progress/<course-v1-id>/detail?user=<guid>`). Turns one raw
 * payload into a flat, DB-agnostic shape. No DB — the upsert lives in
 * `src/server/pathways-detail-logic.ts`.
 *
 * The raw payload is member PII (speech titles, names) — callers must keep raw
 * captures gitignored; only synthetic fixtures live in the repo.
 */
import { extractCourseCode } from "./basecamp-progress";

// --- Raw payload shape (only the slice the parser reads) ---

interface RawBlockNode {
	type: string; // "course" | "chapter" | "sequential"
	display_name: string;
	block_id?: string;
	complete?: boolean;
	block_lib_type?: "imported" | "elective";
	min_req_electives?: number;
	children?: RawBlockNode[];
}

export interface BcmDetailPayload {
	basecampUserId: string; // numeric user.id (string) — the enrollment join key
	courseId: string;
	blocks: RawBlockNode;
	speeches: Record<string, { speech_title?: string; speech_date?: string }>;
}

// --- Parsed shape ---

export interface ParsedDetailProject {
	blockId: string;
	name: string;
	level: number;
	isRequired: boolean; // block_lib_type "imported" → true, "elective" → false
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}

export interface ParsedDetailLevel {
	level: number;
	minReqElectives: number;
}

export interface ParsedDetail {
	basecampUserId: string;
	courseCode: string;
	projects: ParsedDetailProject[];
	levels: ParsedDetailLevel[];
}

const LEVEL_KEY = /^Level (\d+)$/;

export function parseDetailPayload(payload: BcmDetailPayload): ParsedDetail {
	const projects: ParsedDetailProject[] = [];
	const levels: ParsedDetailLevel[] = [];

	for (const chapter of payload.blocks.children ?? []) {
		const match = LEVEL_KEY.exec(chapter.display_name);
		if (!match) continue; // skip "Path Completion" and non-level chapters
		const level = Number(match[1]);
		levels.push({ level, minReqElectives: chapter.min_req_electives ?? 0 });

		for (const node of chapter.children ?? []) {
			if (node.type !== "sequential") continue;
			// Placeholder = unchosen elective slot (empty block_id). Never a project.
			if (!node.block_id) continue;
			const speech = payload.speeches[node.block_id];
			projects.push({
				blockId: node.block_id,
				name: node.display_name,
				level,
				isRequired: node.block_lib_type !== "elective",
				complete: node.complete === true,
				speechTitle: speech?.speech_title ?? null,
				speechDate: speech?.speech_date ? new Date(speech.speech_date) : null,
			});
		}
	}

	return {
		basecampUserId: payload.basecampUserId,
		courseCode: extractCourseCode(payload.courseId),
		projects,
		levels,
	};
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bunx vitest run src/lib/basecamp-detail.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Lint + commit.**

```bash
bun run check
git add src/lib/basecamp-detail.ts src/lib/basecamp-detail.test.ts
git commit -m "feat: pure Base Camp /detail parser (#120)"
```

---

## Task 3: Catalog reconciliation (`reconcileCatalog` in `pathways-detail-logic.ts`)

Stamps `bcm_block_id` onto matched catalog rows, derives required projects we didn't seed, reports unmatched electives, and upserts `pathways_path_levels`. Returns a projectId-by-blockId map for the next task, plus counters.

**Files:**
- Create: `src/server/pathways-detail-logic.ts`
- Test: `src/server/pathways-detail.integration.test.ts`

- [ ] **Step 1: Write the failing integration test.**

Create `src/server/pathways-detail.integration.test.ts`:

```ts
/**
 * DB-backed tests for /detail catalog reconciliation + mirror upsert.
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-detail.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
} from "#/db/schema";
import type { ParsedDetail } from "#/lib/basecamp-detail";
import { hasTestDb, testDb } from "#/test/db";

// (Task 4 extends these imports: add `people, pathEnrollments, bcmProjectProgress`
//  from #/db/schema and `cleanup, seedClub, type SeededClub` from #/test/db.)

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { reconcileCatalog } = await import("./pathways-detail-logic");

const CODE = `8700-${randomUUID().slice(0, 8)}`;

let pathId: string;
let seededIceId: string;

async function seed() {
	const [p] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: CODE, name: "Motivational Strategies" })
		.returning({ id: pathwaysPaths.id });
	pathId = p.id;
	// A hand-seeded catalog row with NO block id yet (the fallback FK target).
	const [ice] = await testDb
		.insert(pathwaysProjects)
		.values({ pathId, level: 1, name: "Ice Breaker", isRequired: true })
		.returning({ id: pathwaysProjects.id });
	seededIceId = ice.id;
}

function detail(over: Partial<ParsedDetail> = {}): ParsedDetail {
	return {
		basecampUserId: "122747",
		courseCode: CODE,
		levels: [{ level: 1, minReqElectives: 0 }, { level: 3, minReqElectives: 2 }],
		projects: [
			// matches the seeded row → should be STAMPED (same id)
			{ blockId: "b-ice", name: "Ice Breaker", level: 1, isRequired: true, complete: true, speechTitle: null, speechDate: null },
			// required, not seeded → should be CREATED
			{ blockId: "b-purpose", name: "Writing a Speech with Purpose", level: 1, isRequired: true, complete: true, speechTitle: null, speechDate: null },
			// elective, not seeded → should be REPORTED, not created
			{ blockId: "b-social", name: "Deliver Social Speeches", level: 3, isRequired: false, complete: true, speechTitle: null, speechDate: null },
		],
		...over,
	};
}

describe.skipIf(!hasTestDb)("reconcileCatalog", () => {
	beforeAll(seed);
	afterAll(async () => {
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, pathId));
		// pathwaysProjects + pathwaysPathLevels cascade on path delete.
	});

	it("stamps matched rows, creates required, reports electives, upserts levels", async () => {
		const res = await reconcileCatalog([detail()]);

		// Stamped the existing Ice Breaker row IN PLACE (same id → FK preserved).
		const ice = await testDb
			.select()
			.from(pathwaysProjects)
			.where(eq(pathwaysProjects.id, seededIceId));
		expect(ice[0].bcmBlockId).toBe("b-ice");

		// Created the required "Writing a Speech with Purpose".
		const created = await testDb
			.select()
			.from(pathwaysProjects)
			.where(and(eq(pathwaysProjects.pathId, pathId), eq(pathwaysProjects.bcmBlockId, "b-purpose")));
		expect(created).toHaveLength(1);
		expect(created[0].isRequired).toBe(true);

		// Elective NOT created; reported instead.
		const socialRows = await testDb
			.select()
			.from(pathwaysProjects)
			.where(and(eq(pathwaysProjects.pathId, pathId), eq(pathwaysProjects.name, "Deliver Social Speeches")));
		expect(socialRows).toHaveLength(0);
		expect(res.unmatchedElectives).toEqual([
			{ courseCode: CODE, name: "Deliver Social Speeches", level: 3 },
		]);

		expect(res.projectsStamped).toBe(1);
		expect(res.projectsDerived).toBe(1);

		// path_levels upserted.
		const levels = await testDb
			.select()
			.from(pathwaysPathLevels)
			.where(eq(pathwaysPathLevels.pathId, pathId));
		expect(levels.find((l) => l.level === 3)?.minReqElectives).toBe(2);

		// The returned map lets the caller resolve blockId → catalog projectId.
		expect(res.projectIdByBlockId.get("b-ice")).toBe(seededIceId);
		expect(res.projectIdByBlockId.get("b-purpose")).toBe(created[0].id);
		expect(res.projectIdByBlockId.has("b-social")).toBe(false);
	});

	it("re-stamping by block id is idempotent and updates a renamed project", async () => {
		const renamed = detail({
			projects: [
				{ blockId: "b-ice", name: "Ice Breaker (Revised)", level: 1, isRequired: true, complete: true, speechTitle: null, speechDate: null },
			],
			levels: [{ level: 1, minReqElectives: 0 }],
		});
		const res = await reconcileCatalog([renamed]);
		const ice = await testDb
			.select()
			.from(pathwaysProjects)
			.where(eq(pathwaysProjects.id, seededIceId));
		// Same row (matched by block id), name updated, no duplicate created.
		expect(ice[0].name).toBe("Ice Breaker (Revised)");
		expect(res.projectsStamped).toBe(0); // already stamped
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-detail.integration.test.ts`
Expected: FAIL — `Cannot find module './pathways-detail-logic'`.

- [ ] **Step 3: Implement `reconcileCatalog`.**

Create `src/server/pathways-detail-logic.ts`:

```ts
/**
 * DB logic for the Base Camp /detail sync (spec 2026-07-07). Two responsibilities:
 *  - reconcileCatalog: stamp bcm_block_id onto matched catalog rows, derive
 *    required projects we didn't seed, report unmatched electives, upsert
 *    pathways_path_levels. Upsert-in-place so speeches.project_id FKs survive.
 *  - syncClubDetail (Task 4): resolve enrollments + replace-per-enrollment the
 *    bcm_project_progress mirror.
 *
 * A `-logic.ts` so `#/db` never leaks into the client bundle (server-modules
 * guard). Never imported by client code.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
} from "#/db/schema";
import type { ParsedDetail } from "#/lib/basecamp-detail";

export interface UnmatchedElective {
	courseCode: string;
	name: string;
	level: number;
}

export interface CatalogReconResult {
	projectsStamped: number;
	projectsDerived: number;
	unmatchedElectives: UnmatchedElective[];
	// blockId → catalog projectId, for building the per-member mirror rows.
	projectIdByBlockId: Map<string, string>;
}

/** courseCode → pathId, resolving each code once. Unknown codes are skipped. */
async function resolvePathIds(
	details: ParsedDetail[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const code of new Set(details.map((d) => d.courseCode))) {
		const [row] = await db
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, code));
		if (row) map.set(code, row.id);
	}
	return map;
}

export async function reconcileCatalog(
	details: ParsedDetail[],
): Promise<CatalogReconResult> {
	const res: CatalogReconResult = {
		projectsStamped: 0,
		projectsDerived: 0,
		unmatchedElectives: [],
		projectIdByBlockId: new Map(),
	};
	const pathIds = await resolvePathIds(details);

	for (const detail of details) {
		const pathId = pathIds.get(detail.courseCode);
		if (!pathId) continue; // path not synced (summary handles path creation)

		// Upsert per-level chapter facts.
		for (const lvl of detail.levels) {
			await db
				.insert(pathwaysPathLevels)
				.values({ pathId, level: lvl.level, minReqElectives: lvl.minReqElectives })
				.onConflictDoUpdate({
					target: [pathwaysPathLevels.pathId, pathwaysPathLevels.level],
					set: { minReqElectives: lvl.minReqElectives },
				});
		}

		for (const proj of detail.projects) {
			// 1) Match by durable block id (handles renames → same row).
			const [byBlock] = await db
				.select({ id: pathwaysProjects.id, name: pathwaysProjects.name })
				.from(pathwaysProjects)
				.where(eq(pathwaysProjects.bcmBlockId, proj.blockId));
			if (byBlock) {
				if (byBlock.name !== proj.name) {
					await db
						.update(pathwaysProjects)
						.set({ name: proj.name })
						.where(eq(pathwaysProjects.id, byBlock.id));
				}
				res.projectIdByBlockId.set(proj.blockId, byBlock.id);
				continue;
			}

			// 2) Match an unstamped hand-seeded row by (path, level, name) → stamp it.
			const [byName] = await db
				.select({ id: pathwaysProjects.id })
				.from(pathwaysProjects)
				.where(
					and(
						eq(pathwaysProjects.pathId, pathId),
						eq(pathwaysProjects.level, proj.level),
						eq(pathwaysProjects.name, proj.name),
					),
				);
			if (byName) {
				await db
					.update(pathwaysProjects)
					.set({ bcmBlockId: proj.blockId })
					.where(eq(pathwaysProjects.id, byName.id));
				res.projectsStamped += 1;
				res.projectIdByBlockId.set(proj.blockId, byName.id);
				continue;
			}

			// 3) No catalog match. Derive required projects; report electives.
			if (proj.isRequired) {
				const [created] = await db
					.insert(pathwaysProjects)
					.values({
						pathId,
						level: proj.level,
						name: proj.name,
						isRequired: true,
						bcmBlockId: proj.blockId,
					})
					.returning({ id: pathwaysProjects.id });
				res.projectsDerived += 1;
				res.projectIdByBlockId.set(proj.blockId, created.id);
			} else {
				res.unmatchedElectives.push({
					courseCode: detail.courseCode,
					name: proj.name,
					level: proj.level,
				});
			}
		}
	}

	return res;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-detail.integration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Lint + commit.**

```bash
bun run check
git add src/server/pathways-detail-logic.ts src/server/pathways-detail.integration.test.ts
git commit -m "feat: /detail catalog reconciliation — stamp/derive/report + path_levels (#120)"
```

---

## Task 4: Mirror upsert (`syncClubDetail`)

Resolves each parsed detail to an enrollment (numeric `basecampUserId` + `courseCode`, scoped to the club), then **replace-per-enrollment** writes `bcm_project_progress`. Enrollments absent from the batch are left untouched (last-known-good).

**Files:**
- Modify: `src/server/pathways-detail-logic.ts`
- Modify: `src/server/pathways-detail.integration.test.ts`

- [ ] **Step 1: Add the failing test.**

Append inside `src/server/pathways-detail.integration.test.ts` a new `describe.skipIf(!hasTestDb)("syncClubDetail", …)` block. Use the shared `seedClub`/`cleanup` helpers (same as the ingest suite) rather than hand-inserting `clubs`/`members`/`people` — that avoids missing NOT NULL columns and the `clubRole` field. Add these to the top-of-file imports (merge with existing): from `#/test/db` add `cleanup, seedClub, type SeededClub`; from `#/db/schema` add `people, pathEnrollments, bcmProjectProgress`.

```ts
describe.skipIf(!hasTestDb)("syncClubDetail", () => {
	const D_CODE = `8700-${randomUUID().slice(0, 8)}`;
	const BC_ID = `77${randomUUID().slice(0, 6)}`;
	let seed: SeededClub;
	let clubId: string;
	let enrollmentId: string;
	let iceId: string;

	beforeAll(async () => {
		seed = await seedClub();
		clubId = seed.clubId;
		// Give the seeded roster person a Base Camp id (the detail join key).
		await testDb
			.update(people)
			.set({ basecampUserId: BC_ID })
			.where(eq(people.id, seed.personId));
		const [path] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: D_CODE, name: "Motivational Strategies" })
			.returning({ id: pathwaysPaths.id });
		const [proj] = await testDb
			.insert(pathwaysProjects)
			.values({ pathId: path.id, level: 1, name: "Ice Breaker", isRequired: true, bcmBlockId: `ice-${D_CODE}` })
			.returning({ id: pathwaysProjects.id });
		iceId = proj.id;
		const [enr] = await testDb
			.insert(pathEnrollments)
			.values({ personId: seed.personId, pathId: path.id })
			.returning({ id: pathEnrollments.id });
		enrollmentId = enr.id;
	});

	afterAll(async () => {
		// people delete cascades enrollments → bcm_project_progress; path delete
		// cascades projects + path_levels; cleanup removes the club + users.
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.courseCode, D_CODE));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	function detailFor(over: Partial<ParsedDetail> = {}): ParsedDetail {
		return {
			basecampUserId: BC_ID,
			courseCode: D_CODE,
			levels: [{ level: 1, minReqElectives: 0 }],
			projects: [
				{ blockId: `ice-${D_CODE}`, name: "Ice Breaker", level: 1, isRequired: true, complete: true, speechTitle: "First Speech", speechDate: new Date("2025-01-05T08:00:00Z") },
			],
			...over,
		};
	}

	it("writes a mirror row for a matched enrollment", async () => {
		const res = await syncClubDetail(clubId, [detailFor()]);
		expect(res.membersWithDetail).toBe(1);
		const rows = await testDb
			.select()
			.from(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ projectId: iceId, complete: true, speechTitle: "First Speech" });
	});

	it("replace-per-enrollment removes rows dropped from the latest detail", async () => {
		// Second sync with NO projects → the previous Ice Breaker row is removed.
		await syncClubDetail(clubId, [detailFor({ projects: [] })]);
		const rows = await testDb
			.select()
			.from(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));
		expect(rows).toHaveLength(0);
	});

	it("leaves an enrollment absent from the batch untouched (last-known-good)", async () => {
		await syncClubDetail(clubId, [detailFor()]); // re-populate
		// Empty batch: nothing to sync → existing rows survive.
		const res = await syncClubDetail(clubId, []);
		expect(res.membersWithDetail).toBe(0);
		const rows = await testDb
			.select()
			.from(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));
		expect(rows).toHaveLength(1);
	});

	it("reports an unmatched detail member (no enrollment)", async () => {
		const res = await syncClubDetail(clubId, [detailFor({ basecampUserId: "does-not-exist" })]);
		expect(res.unmatchedMembers).toBe(1);
		expect(res.membersWithDetail).toBe(0);
	});
});
```

Add `syncClubDetail` to the import at the top of the test file:

```ts
const { reconcileCatalog, syncClubDetail } = await import("./pathways-detail-logic");
```

- [ ] **Step 2: Run to verify it fails.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-detail.integration.test.ts`
Expected: FAIL — `syncClubDetail is not a function`.

- [ ] **Step 3: Implement `syncClubDetail`.**

Append to `src/server/pathways-detail-logic.ts`. Add `members`, `people`, `pathEnrollments`, `bcmProjectProgress` to the schema import, and add:

```ts
export interface DetailSyncResult {
	membersWithDetail: number;
	unmatchedMembers: number;
	projectsStamped: number;
	projectsDerived: number;
	unmatchedElectives: UnmatchedElective[];
}

/**
 * Resolve (numeric basecampUserId + courseCode) → enrollmentId, scoped to the
 * club's roster (same club-scoping rule as summary sync — a person must have a
 * `members` row for this club). Returns null when no enrollment matches.
 */
async function resolveEnrollmentId(
	clubId: string,
	basecampUserId: string,
	courseCode: string,
): Promise<string | null> {
	const rows = await db
		.selectDistinct({ id: pathEnrollments.id })
		.from(pathEnrollments)
		.innerJoin(people, eq(people.id, pathEnrollments.personId))
		.innerJoin(
			members,
			and(eq(members.personId, people.id), eq(members.clubId, clubId)),
		)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathEnrollments.pathId))
		.where(
			and(
				eq(people.basecampUserId, basecampUserId),
				eq(pathwaysPaths.courseCode, courseCode),
			),
		);
	return rows.length === 1 ? rows[0].id : null;
}

export async function syncClubDetail(
	clubId: string,
	details: ParsedDetail[],
): Promise<DetailSyncResult> {
	const recon = await reconcileCatalog(details);
	const result: DetailSyncResult = {
		membersWithDetail: 0,
		unmatchedMembers: 0,
		projectsStamped: recon.projectsStamped,
		projectsDerived: recon.projectsDerived,
		unmatchedElectives: recon.unmatchedElectives,
	};

	for (const detail of details) {
		const enrollmentId = await resolveEnrollmentId(
			clubId,
			detail.basecampUserId,
			detail.courseCode,
		);
		if (!enrollmentId) {
			result.unmatchedMembers += 1;
			continue;
		}

		// Replace-per-enrollment: clear then insert this enrollment's rows. Only
		// enrollments present in `details` are touched (last-known-good otherwise).
		await db
			.delete(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));

		for (const proj of detail.projects) {
			const projectId = recon.projectIdByBlockId.get(proj.blockId);
			if (!projectId) continue; // unmatched elective — no catalog row to attribute
			await db.insert(bcmProjectProgress).values({
				enrollmentId,
				projectId,
				complete: proj.complete,
				speechTitle: proj.speechTitle,
				speechDate: proj.speechDate,
			});
		}
		result.membersWithDetail += 1;
	}

	return result;
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-detail.integration.test.ts`
Expected: PASS (all `reconcileCatalog` + `syncClubDetail` tests).

- [ ] **Step 5: Lint + commit.**

```bash
bun run check
git add src/server/pathways-detail-logic.ts src/server/pathways-detail.integration.test.ts
git commit -m "feat: syncClubDetail — replace-per-enrollment mirror upsert, last-known-good (#120)"
```

---

## Task 5: Ingest wiring (optional `details`, backward-compatible)

Extend `ingestForToken` to accept an optional `details` array, parse each payload, run `syncClubDetail`, and merge a `detail` block into the returned result. A summary-only body must behave exactly as today.

**Files:**
- Modify: `src/server/pathways-ingest-logic.ts`
- Test: `src/server/pathways-ingest-logic.integration.test.ts` (existing — add cases)

- [ ] **Step 1: Add failing tests for the new field + backward-compat.**

Open `src/server/pathways-ingest-logic.integration.test.ts`. It already has `seedClub`/`cleanup` in `beforeEach`/`afterEach`, a `pageForEmail(email)` fixture (member matched by email on `course-v1:Toastmasters+8701+8_15_2023`, `user.id: 122747`), an `mkToken()` helper, and `memberEmail`. After the summary sync runs, that member's Person has `basecampUserId = "122747"` (stored via the email match) and an enrollment on course `8701` — so a detail payload keyed by `122747` + that course id joins to it. Add these two tests inside the existing `describe`:

```ts
// A /detail payload for the same member (122747) + path (8701) the summary
// fixture ingests — so the enrollment it joins to is created by the same POST.
function detailFor122747() {
	return {
		basecampUserId: "122747",
		courseId: "course-v1:Toastmasters+8701+8_15_2023",
		blocks: {
			type: "course",
			display_name: "Presentation Mastery",
			children: [
				{
					type: "chapter",
					display_name: "Level 1",
					complete: true,
					min_req_electives: 0,
					children: [
						{ block_id: "ib-8701", type: "sequential", display_name: "Ice Breaker", complete: true, block_lib_type: "imported" },
					],
				},
			],
		},
		speeches: {},
	};
}

it("ingests details and returns a detail block", async () => {
	const { ingestForToken } = await import("#/server/pathways-ingest-logic");
	const { token } = await mkToken();
	const res = await ingestForToken(token, {
		basecampClubGuid: "club-guid-1",
		pages: [pageForEmail(memberEmail)],
		details: [detailFor122747()],
	});
	expect(res.detail?.membersWithDetail).toBe(1);
	// "Ice Breaker" wasn't seeded → derived as a required project.
	expect(res.detail?.projectsDerived).toBe(1);
});

it("still works with no details (backward compatible)", async () => {
	const { ingestForToken } = await import("#/server/pathways-ingest-logic");
	const { token } = await mkToken();
	const res = await ingestForToken(token, {
		basecampClubGuid: "club-guid-1",
		pages: [pageForEmail(memberEmail)],
	});
	expect(res.detail).toBeUndefined();
	expect(res.matched).toBe(1);
});
```

- [ ] **Step 2: Run to verify the new tests fail.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-ingest-logic.integration.test.ts`
Expected: FAIL — `res.detail` is undefined when details are provided (feature not implemented).

- [ ] **Step 3: Extend the body schema + parse + sync.**

In `src/server/pathways-ingest-logic.ts`:

Add imports:

```ts
import { type BcmDetailPayload, parseDetailPayload } from "#/lib/basecamp-detail";
import { type DetailSyncResult, syncClubDetail } from "./pathways-detail-logic";
```

Extend the body schema (`details` optional):

```ts
const bodySchema = z.object({
	basecampClubGuid: z.string().min(1),
	pages: z.array(z.unknown()).min(1),
	details: z.array(z.unknown()).optional(),
});
```

Change the function's return type and, after the existing `syncClubProgress` call, add the detail branch:

```ts
export async function ingestForToken(
	rawToken: string | null,
	body: unknown,
): Promise<SyncResult & { warning?: string; detail?: DetailSyncResult }> {
	// … existing token/parse/rows logic unchanged …

	const result = await syncClubProgress(tok.clubId, rows);
	const warning = await recordTokenUse(tok, parsed.data.basecampClubGuid);

	let detail: DetailSyncResult | undefined;
	if (parsed.data.details && parsed.data.details.length > 0) {
		let parsedDetails: ReturnType<typeof parseDetailPayload>[];
		try {
			parsedDetails = (parsed.data.details as BcmDetailPayload[]).map(
				parseDetailPayload,
			);
		} catch {
			throw new IngestError(
				400,
				"That doesn't look like Base Camp /detail data (expected the /detail JSON).",
			);
		}
		detail = await syncClubDetail(tok.clubId, parsedDetails);
	}

	return {
		...result,
		...(warning ? { warning } : {}),
		...(detail ? { detail } : {}),
	};
}
```

- [ ] **Step 4: Run to verify all ingest tests pass.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-ingest-logic.integration.test.ts`
Expected: PASS (existing + the two new cases).

- [ ] **Step 5: Run the server-modules guard + full test suite.**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS — `pathways-detail-logic.ts` is a `-logic.ts` (not a `createServerFn` module), so it's outside the guard's scope; the guard stays green.

- [ ] **Step 6: Lint + commit.**

```bash
bun run check
git add src/server/pathways-ingest-logic.ts src/server/pathways-ingest-logic.integration.test.ts
git commit -m "feat: ingest accepts optional /detail payloads, returns detail result (#120)"
```

---

## Task 6: Extension detail fan-out (pure, testable)

A pure module that (a) extracts detail targets from the raw summary pages and (b) fans out `/detail` calls with bounded concurrency and graceful per-call failure. Injectable fetch → unit-testable in Node.

**Files:**
- Create: `extension/lib/basecamp-detail-walk.ts`
- Test: `extension/lib/basecamp-detail-walk.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `extension/lib/basecamp-detail-walk.test.ts`:

```ts
/**
 * Unit tests for the pure /detail fan-out. Injectable fetch, no browser.
 * Run: cd extension && bunx vitest run lib/basecamp-detail-walk.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	extractDetailTargets,
	fetchDetails,
} from "./basecamp-detail-walk";

const pages = [
	{
		results: [
			{ user: { id: 122747, username: "guid-a" }, course_id: "course-v1:Toastmasters+8700+x" },
			{ user: { id: 55, username: "guid-b" }, course_id: "course-v1:Toastmasters+8701+x" },
		],
		next: null,
	},
];

describe("extractDetailTargets", () => {
	it("pulls (numeric id, guid, courseId) per member-path row", () => {
		expect(extractDetailTargets(pages)).toEqual([
			{ basecampUserId: "122747", guid: "guid-a", courseId: "course-v1:Toastmasters+8700+x" },
			{ basecampUserId: "55", guid: "guid-b", courseId: "course-v1:Toastmasters+8701+x" },
		]);
	});
});

describe("fetchDetails", () => {
	it("fetches each target and tags the payload with the numeric id + courseId", async () => {
		const targets = extractDetailTargets(pages);
		const fetchImpl = async (url: string) => ({
			ok: true,
			status: 200,
			json: async () => ({ blocks: { type: "course", display_name: "P", children: [] }, speeches: {} }),
		});
		const out = await fetchDetails({ fetchImpl, targets, csrftoken: "t", concurrency: 2 });
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ basecampUserId: "122747", courseId: "course-v1:Toastmasters+8700+x" });
		expect(out[0].blocks).toBeDefined();
	});

	it("omits a target whose call fails, keeps the rest (graceful per-call)", async () => {
		const targets = extractDetailTargets(pages);
		const fetchImpl = async (url: string) => {
			if (url.includes("guid-a")) throw new Error("boom");
			return { ok: true, status: 200, json: async () => ({ blocks: { type: "course", display_name: "P", children: [] }, speeches: {} }) };
		};
		const out = await fetchDetails({ fetchImpl, targets, csrftoken: "t", concurrency: 2 });
		expect(out).toHaveLength(1);
		expect(out[0].basecampUserId).toBe("55");
	});

	it("omits a target that returns a non-ok status", async () => {
		const targets = extractDetailTargets(pages);
		const fetchImpl = async (url: string) => ({
			ok: url.includes("guid-b"),
			status: url.includes("guid-b") ? 200 : 500,
			json: async () => ({ blocks: { type: "course", display_name: "P", children: [] }, speeches: {} }),
		});
		const out = await fetchDetails({ fetchImpl, targets, csrftoken: "t", concurrency: 1 });
		expect(out.map((d) => d.basecampUserId)).toEqual(["55"]);
	});
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd extension && bunx vitest run lib/basecamp-detail-walk.test.ts`
Expected: FAIL — `Cannot find module './basecamp-detail-walk'`.

- [ ] **Step 3: Implement the fan-out.**

Create `extension/lib/basecamp-detail-walk.ts`:

```ts
/**
 * Pure Base Camp /detail fan-out for the GavelUp sync extension (#120). No DOM,
 * no browser APIs — fetch is injected so it is unit-testable in Node.
 *
 * Graceful per-call (unlike the all-or-nothing summary walk): a failed /detail
 * call omits that member from the batch — their count-based data still synced
 * from the summary, and the next sync retries. One bad call never aborts sync.
 */
const DETAIL_BASE = "https://basecamp.toastmasters.org/api/bcm/progress";

interface FetchLike {
	(
		url: string,
		opts: RequestInit,
	): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface DetailTarget {
	basecampUserId: string; // numeric user.id (string)
	guid: string; // user.username — the ?user= param
	courseId: string;
}

/** Payload POSTed to /api/pathways/ingest under `details`. */
export interface DetailPayload {
	basecampUserId: string;
	courseId: string;
	blocks: unknown;
	speeches: unknown;
}

interface RawRow {
	user?: { id?: number | string; username?: string };
	course_id?: string;
}
interface RawPage {
	results: unknown[];
}

export function extractDetailTargets(pages: RawPage[]): DetailTarget[] {
	const targets: DetailTarget[] = [];
	for (const page of pages) {
		for (const row of page.results as RawRow[]) {
			const id = row.user?.id;
			const guid = row.user?.username;
			const courseId = row.course_id;
			if (id == null || !guid || !courseId) continue;
			targets.push({ basecampUserId: String(id), guid, courseId });
		}
	}
	return targets;
}

async function fetchOne(
	fetchImpl: FetchLike,
	target: DetailTarget,
	csrftoken: string,
): Promise<DetailPayload | null> {
	const url = `${DETAIL_BASE}/${encodeURIComponent(target.courseId)}/detail?user=${encodeURIComponent(target.guid)}&page_size=5000`;
	try {
		const res = await fetchImpl(url, {
			headers: {
				Accept: "application/json",
				"USE-JWT-COOKIE": "true",
				"X-Platform": "pathways",
				"X-CSRFToken": csrftoken || "",
			},
			credentials: "include",
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { blocks?: unknown; speeches?: unknown };
		return {
			basecampUserId: target.basecampUserId,
			courseId: target.courseId,
			blocks: body.blocks ?? { type: "course", children: [] },
			speeches: body.speeches ?? {},
		};
	} catch {
		return null; // graceful: omit this member
	}
}

/** Fan out with bounded concurrency; omit any target that fails. */
export async function fetchDetails(args: {
	fetchImpl: FetchLike;
	targets: DetailTarget[];
	csrftoken: string;
	concurrency?: number;
}): Promise<DetailPayload[]> {
	const { fetchImpl, targets, csrftoken, concurrency = 3 } = args;
	const out: DetailPayload[] = [];
	let cursor = 0;

	async function worker() {
		while (cursor < targets.length) {
			const target = targets[cursor++];
			const payload = await fetchOne(fetchImpl, target, csrftoken);
			if (payload) out.push(payload);
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, targets.length) },
		worker,
	);
	await Promise.all(workers);
	return out;
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `cd extension && bunx vitest run lib/basecamp-detail-walk.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit.**

```bash
cd extension && bunx biome check --write lib/basecamp-detail-walk.ts lib/basecamp-detail-walk.test.ts; cd ..
git add extension/lib/basecamp-detail-walk.ts extension/lib/basecamp-detail-walk.test.ts
git commit -m "feat(ext): pure /detail fan-out (bounded concurrency, graceful failure) (#120)"
```

---

## Task 7: Wire the extension (messages, content script, background)

Thread `details` through the message contract, gather + send them from the content script after the summary walk, and include them in the background POST.

**Files:**
- Modify: `extension/lib/messages.ts`
- Modify: `extension/entrypoints/basecamp.content.ts`
- Modify: `extension/entrypoints/background.ts`

- [ ] **Step 1: Extend the message contract.**

In `extension/lib/messages.ts`:

Add `details` to `IngestRequest`, and a `detail` block to `SyncResultLike`:

```ts
import type { DetailPayload } from "./basecamp-detail-walk";

export interface SyncResultLike {
	matched: number;
	pathsUpserted: number;
	unmatched: { name: string; email: string | null; basecampUserId: string }[];
	warning?: string;
	detail?: {
		membersWithDetail: number;
		unmatchedMembers: number;
		projectsStamped: number;
		projectsDerived: number;
		unmatchedElectives: { courseCode: string; name: string; level: number }[];
	};
}

export interface IngestRequest {
	type: "gavelup-ingest";
	guid: string;
	pages: unknown[];
	details?: DetailPayload[];
}
```

- [ ] **Step 2: Include `details` in the background POST.**

In `extension/entrypoints/background.ts`, change the fetch body to pass details through:

```ts
					body: JSON.stringify({
						basecampClubGuid: msg.guid,
						pages: msg.pages,
						...(msg.details ? { details: msg.details } : {}),
					}),
```

- [ ] **Step 3: Gather + send details from the content script.**

In `extension/entrypoints/basecamp.content.ts`, add the import at the top:

```ts
import { extractDetailTargets, fetchDetails } from "../lib/basecamp-detail-walk";
```

In the `btn` click handler, after the `walkProgressPages` call and before the `sendMessage`, gather details and update the status line. Replace the block that currently reads:

```ts
				const pages = await walkProgressPages({
					fetchImpl: (url, opts) => fetch(url, opts),
					guid,
					csrftoken: readCookie("csrftoken"),
				});
				const res = (await browser.runtime.sendMessage({
					type: "gavelup-ingest",
					guid,
					pages,
				} satisfies IngestRequest)) as IngestResponse;
```

with:

```ts
				const csrftoken = readCookie("csrftoken");
				const pages = await walkProgressPages({
					fetchImpl: (url, opts) => fetch(url, opts),
					guid,
					csrftoken,
				});

				const targets = extractDetailTargets(pages as { results: unknown[] }[]);
				setStatus(`Syncing… fetching details (0/${targets.length})`);
				const details = await fetchDetails({
					fetchImpl: (url, opts) => fetch(url, opts),
					targets,
					csrftoken,
				});

				const res = (await browser.runtime.sendMessage({
					type: "gavelup-ingest",
					guid,
					pages,
					details,
				} satisfies IngestRequest)) as IngestResponse;
```

- [ ] **Step 4: Surface detail counts in the status line.**

In the same handler, extend the success `setStatus`. Replace:

```ts
				const base = `Matched ${r.matched} · ${r.pathsUpserted} path(s) updated · ${r.unmatched.length} unmatched`;
				setStatus(r.warning ? `${base}\n⚠ ${r.warning}` : base, r.warning ? "#b45309" : "#065f46");
```

with:

```ts
				let base = `Matched ${r.matched} · ${r.pathsUpserted} path(s) updated · ${r.unmatched.length} unmatched`;
				if (r.detail) {
					base += `\nDetails: ${r.detail.membersWithDetail} member(s), ${r.detail.projectsStamped + r.detail.projectsDerived} project(s) linked`;
				}
				setStatus(r.warning ? `${base}\n⚠ ${r.warning}` : base, r.warning ? "#b45309" : "#065f46");
```

- [ ] **Step 5: Type-check + run the extension test suite.**

Run: `cd extension && bunx tsc --noEmit && bunx vitest run; cd ..`
Expected: no type errors; all extension tests pass (walk + detail-walk).

- [ ] **Step 6: Commit.**

```bash
cd extension && bunx biome check --write lib/messages.ts entrypoints/background.ts entrypoints/basecamp.content.ts; cd ..
git add extension/lib/messages.ts extension/entrypoints/background.ts extension/entrypoints/basecamp.content.ts
git commit -m "feat(ext): fan out /detail after summary walk and POST it (#120)"
```

---

## Task 8: Documentation — ADR-0011 + progression-model supersede note

**Files:**
- Create: `docs/adr/0011-basecamp-detail-project-completion.md`
- Modify: `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md`

- [ ] **Step 1: Write ADR-0011.**

Create `docs/adr/0011-basecamp-detail-project-completion.md`:

```markdown
# ADR-0011: Base Camp /detail — authoritative per-project completion + speeches

Status: Accepted

## Context

The Pathways progression model (spec 2026-07-06, ADR-0009) was built on two
assumptions: that Base Camp exposes only per-*level* counts (so project identity
"can never come from Base Camp"), and that speech-level data isn't exposed. A
per-member `/detail` endpoint disproves both — it returns per-project `complete`
flags with names, plus a speeches map (title + date). See #120.

## Decision

Use `/detail` as the authoritative source of named per-project completion and
speech history, **augmenting** (not replacing) the count-based mirror.

- A read-only mirror (`bcm_project_progress`) records per-project `complete` +
  speech title/date, re-derived every sync (replace-per-enrollment;
  last-known-good for members absent from a sync).
- The hand-seeded catalog **stays** the source of the elective *pool* — Base Camp
  never enumerates a member's *unchosen* electives (only placeholders), so the
  pool cannot be derived from `/detail`. `/detail` stamps `bcm_block_id` onto
  matched catalog rows and derives required (`imported`) projects we didn't seed.
- Our person-owned `speeches` table (ADR-0009) is untouched — no Base Camp data
  is written into it; the two sources coexist without merge/dedup.

## Consequences

- "Your wins" / "up next" / speech history can be sourced authoritatively from
  Base Camp instead of inferred from a member's own logged speeches; the
  inference path remains the fallback when an enrollment has no detail rows.
- Reverses the two assumptions in the 2026-07-06 progression-model spec (a
  superseding note is appended there).
- The extension does a bounded `members × paths` fan-out of `/detail` calls,
  graceful per-call, after its summary walk.
```

- [ ] **Step 2: Append the supersede note to the progression-model spec.**

Add to the end of `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md`:

```markdown

## Superseded assumptions (see 2026-07-07 /detail spec + ADR-0011)

Two "decisive facts" above were later disproven by Base Camp's per-member
`/detail` endpoint (#120):

- *"project identity can never come from Base Camp"* — **false**;
  `blocks[].children[].complete` gives named per-project completion.
- *"scraping speech-level data (it isn't exposed)"* — **false**; `/detail`
  returns a speeches map (title + date).

The `/detail` design **augments** this model (it does not replace the count-based
mirror): see `2026-07-07-pathways-detail-endpoint-design.md` and ADR-0011. The
elective-pool reasoning here still holds — Base Camp does not enumerate a
member's *unchosen* electives — which is why the hand-seeded catalog is retained.
```

- [ ] **Step 3: Commit.**

```bash
git add docs/adr/0011-basecamp-detail-project-completion.md docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md
git commit -m "docs: ADR-0011 + supersede note for Base Camp /detail (#120)"
```

---

## Final verification

- [ ] **Full check + test gate.**

Run: `bun run check`
Expected: no lint/format errors.

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run`
Expected: all suites pass (including the new `basecamp-detail`, `pathways-detail`, and the extended `pathways-ingest-logic`).

Run: `cd extension && bunx vitest run && bunx tsc --noEmit; cd ..`
Expected: extension tests pass, no type errors.

- [ ] **Build (type-check surface).**

Run: `bun run build`
Expected: builds clean (surfaces any TS errors the way CI does).

---

## Definition of done (Slice 1)

- A sync (extension or a hand-crafted POST) carrying `pages` + `details` populates
  `bcm_project_progress` for matched members, stamps/derives catalog rows, and
  upserts `pathways_path_levels`.
- A summary-only POST (no `details`) behaves exactly as before.
- A failed detail call omits only that member; a member absent from a sync keeps
  last-known-good rows.
- No UI change (Slice 2). Read-side wiring is a separate plan.
```
