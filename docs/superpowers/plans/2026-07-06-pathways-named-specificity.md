# Pathways Named Specificity (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add project-level *names* to the count-based Pathways progress: a `pathways_projects` catalog, a `speeches.project_id` FK (closing #101), a migration off today's free-text speech fields, and the UI's "Your wins" (named, from delivered speeches) + named "Up next" for the current level.

**Architecture:** Phase 1 shipped the count-based mirror (`pathways_paths` / `path_enrollments` / `path_level_progress`, synced from Base Camp). Phase 2 layers *names* on top from two honest sources: a static **catalog** (project names per path/level) and the member's **own speeches** (`speeches.project_id`). Base Camp still owns the counts; names never override the count truth (per the locked "no apology" design).

**Tech Stack:** Drizzle, TanStack Start, React 19, shadcn/Tailwind, Vitest, Biome. Bun.

**Prerequisites (both merged to `main`):** #64 (`people`), #79 (`speeches` — currently free-text `pathway_path`/`project_name`/`project_level` + `role_slots.speech_id`), and Phase 1 (PR #112: pathways tables, `<PathwaysProgress>`, reads). This branch is off merged `main`.

**Spec:** `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md` (§Named wins, §Phase 2).

> **⚠️ Catalog-data dependency (Task 2):** the project *names* per path/level are not something the app can derive — Base Camp's API gives counts only. They must be hand-curated from the community "Pathways Paths and Projects Catalog" PDF (no official machine-readable source exists). Task 2 is a data-entry task whose accuracy matters (user-facing + matched against speeches). The other tasks (machinery + UI) are testable with a partial catalog, so they're not blocked on completing all 11 paths.

---

## File Structure

- **Modify** `src/db/schema.ts` — add `pathways_projects` table + `speeches.project_id` FK + relations.
- **Create** `src/lib/pathways-catalog.ts` — the hand-curated catalog data (paths → levels → project names, required/elective) as typed reference data.
- **Create** `scripts/seed-pathways-catalog.ts` — idempotent upsert of the catalog into `pathways_paths` (names/status) + `pathways_projects`.
- **Create** `src/server/pathways-project-match-logic.ts` — the free-text → `project_id` resolver (+ test).
- **Modify** `src/server/pathways-read-logic.ts` — extend `PathViewModel` with `wins` (named, delivered) + `upNext` (named catalog projects for the current level).
- **Modify** `src/components/pathways/pathways-progress.tsx` — render "Your wins" + named "Up next".
- Migration generated to `drizzle/`.

---

## Task 1: Schema — `pathways_projects` + `speeches.project_id`

**Files:** Modify `src/db/schema.ts`; generated migration.

- [ ] **Step 1:** Add the table + FK (follow existing style; `pathwaysPaths`/`speeches` already exist):

```ts
export const pathwaysProjects = pgTable(
	"pathways_projects",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		pathId: uuid("path_id")
			.notNull()
			.references(() => pathwaysPaths.id, { onDelete: "cascade" }),
		level: integer("level").notNull(), // 1–5
		name: text("name").notNull(),
		// Required vs elective is display emphasis only — Base Camp counts/`approved`
		// still drive level completion (Phase 1 decision).
		isRequired: boolean("is_required").notNull().default(false),
		sortOrder: integer("sort_order").notNull().default(0),
	},
	(t) => [uniqueIndex("pathways_projects_path_level_name_idx").on(t.pathId, t.level, t.name)],
);
```

Add a nullable FK to the existing `speeches` table columns:
```ts
	projectId: uuid("project_id").references(() => pathwaysProjects.id, { onDelete: "set null" }),
```

Add relations: `pathwaysProjectsRelations` (project → path `one`; project ← speeches `many`), extend `pathwaysPathsRelations` with `projects: many(pathwaysProjects)`, and extend `speechesRelations` with `project: one(pathwaysProjects, ...)`.

- [ ] **Step 2:** `bun run db:generate` → a new `drizzle/00NN_*.sql` (create `pathways_projects`, add `speeches.project_id` + FK). Verify no unrelated drift.
- [ ] **Step 3:** `bun run db:migrate`; also `DATABASE_URL=…tm_test bun run db:migrate`. `bunx tsc --noEmit` clean.
- [ ] **Step 4:** Commit `feat(pathways): pathways_projects catalog + speeches.project_id FK`.

---

## Task 2: Catalog data + seed (⚠️ data-entry — source accuracy matters)

**Files:** Create `src/lib/pathways-catalog.ts`, `scripts/seed-pathways-catalog.ts`.

- [ ] **Step 1: Source the catalog.** Transcribe from the community "Pathways Paths and Projects Catalog" (`westsidetoastmasters.com/education/Pathways-Paths-and-Projects-Catalog-V2.1.pdf`) or an equivalent authoritative source. For each path (keyed by the Base Camp `course_code` we already know for the common ones — 8701 Presentation Mastery, 8700 Motivational Strategies, 8711 Engaging Humor, 8705 Strategic Relationships, 8706 Dynamic Leadership, 8702 Leadership Development, plus the rest), list Levels 1–5 with each project's name + required/elective flag. Structure:

```ts
export interface CatalogProject { name: string; level: number; isRequired: boolean; }
export interface CatalogPath { courseCode: string; name: string; status: "current" | "legacy"; projects: CatalogProject[]; }
export const PATHWAYS_CATALOG: CatalogPath[] = [ /* … */ ];
```

Start with the paths our club actually uses (the 6 above — real fixture data exists) so the feature is usable immediately; the remaining paths can be appended later without code change (the seed is idempotent).

- [ ] **Step 2:** `scripts/seed-pathways-catalog.ts` — for each path: upsert `pathways_paths` by `course_code` (name + status); for each project: upsert `pathways_projects` by (path_id, level, name). Idempotent (`onConflictDoUpdate`/`DoNothing`). Mirror `scripts/import-members.ts` runner style; add a `package.json` script `seed:pathways-catalog`.
- [ ] **Step 3:** Run it against dev; sanity-check counts (`SELECT count(*) FROM pathways_projects`). Commit `feat(pathways): hand-curated project catalog + seed`.

---

## Task 3: Free-text → `project_id` resolver + migration

**Files:** Create `src/server/pathways-project-match-logic.ts` (+ integration test).

- [ ] **Step 1:** `resolveSpeechProjects()` — for each speech with a null `project_id` but non-empty `project_name`, match to a `pathways_projects` row by (path name/`pathway_path` → path, then case-insensitive `project_name` = project name); set `project_id` on a unique match; leave null + count/log the misses. Integration test (tm_test): seeded speeches + catalog → matched ones get the FK, ambiguous/unknown stay null.
- [ ] **Step 2:** A one-off runner (or fold into the catalog seed) to backfill existing speeches. Commit `feat(pathways): resolve free-text speeches to catalog projects`.

Note: keep `pathway_path`/`project_name`/`project_level` columns for now (don't drop) — they're the fallback display when `project_id` is null; a later cleanup can drop them once coverage is high.

---

## Task 4: Extend the read model — wins + named up-next

**Files:** Modify `src/server/pathways-read-logic.ts` (+ extend its tests).

- [ ] **Step 1:** Extend `PathViewModel` with:
  - `wins: { level: number; name: string; speechTitle: string | null; deliveredAt: Date | null }[]` — the person's **delivered** speeches (past-dated slot per ADR-0009) whose `project_id` is in this path, grouped/labeled by project name + level.
  - `upNext: { level: number; name: string; isRequired: boolean }[]` — the current level's catalog projects (from `pathways_projects`) that are NOT already a win. Empty when `complete`.
  Keep `ringPercent`/`currentLevel`/count fields unchanged (Base Camp still owns the count truth).
- [ ] **Step 2:** Update `pathwaysForPerson`/`pathwaysByMember` to join speeches (delivered, by person + project) and the project catalog. Unit-test `buildPathViewModel` wins/up-next derivation; integration-test the joins. Commit `feat(pathways): named wins + up-next in the view model`.

---

## Task 5: UI — render wins + named up-next

**Files:** Modify `src/components/pathways/pathways-progress.tsx`.

- [ ] **Step 1:** In each path block, below the count bar: a **"Your wins"** list (🏆 named projects from `wins`) and a **"Up next"** list of named `upNext` projects ("do it in Base Camp — it'll sync"). Keep the count bar as the source of truth; wins/up-next are the specific layer. Preserve the "no apology" design (never show a gap as a deficiency). Design tokens; theme-safe.
- [ ] **Step 2:** Visual check via dev server (seed a speech linked to a project) — dashboard tile + member-detail show named wins + up-next. Commit `feat(pathways): show named wins + up-next in PathwaysProgress`.

---

## Self-Review
- Closes #101 (`speeches.project_id` FK + catalog + migration).
- Names come only from catalog + the member's own delivered speeches — never fabricated against Base Camp counts (honors the locked design).
- Machinery (Tasks 1, 3, 4, 5) is testable with a partial catalog; Task 2 data-entry can grow without code change.
- Bundle-leak discipline: reads/resolvers in `-logic.ts`; component imports types only.

## Out of scope
- Dropping the free-text speech columns (later cleanup once `project_id` coverage is high).
- The browser extension (#107).
