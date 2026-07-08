# Pathways /detail UI switchover (Slice 2) — design

Date: 2026-07-08
Issue: #121 (this design). Builds on #120/#122 (Slice 1 — the `bcm_project_progress` mirror, merged).
Spec it completes: `2026-07-07-pathways-detail-endpoint-design.md` (Slice 2 section).

> **Decisions made on your behalf (you were away) — please confirm at the review gate.**
> The three product/visual calls are flagged **[DECIDED — confirm]** inline. Everything else
> follows directly from the Slice 1 spec.

## Goal

Make the member Pathways view read the authoritative `bcm_project_progress` mirror for **wins**,
**up next**, and **speech titles/dates** — falling back to today's inference when an enrollment has
no detail rows yet. No schema changes (Slice 1 delivered them); this is a read-side + presentation
slice within the existing locked visual.

## What exists (Slice 1 + current UI)

- `bcm_project_progress { enrollmentId, projectId→pathwaysProjects, complete, speechTitle?, speechDate? }`
  and `pathways_path_levels { pathId, level, minReqElectives }` are populated by the sync.
- The member view (`src/components/pathways/pathways-progress.tsx`) is a locked visual: `ProgressRing`
  (path %), `LevelChips` (approved/current/upcoming), `YourWins` (name + optional speechTitle·date),
  `UpNext` (current-level catalog projects). It renders a `PathViewModel`.
- `PathViewModel` is built purely by `buildPathViewModel(SyncedPath)` in `pathways-read-logic.ts`.
  Today `wins` come from `fetchDeliveredWins` (the member's own delivered speeches → `project_id`),
  and `upNext` = current-level catalog projects minus win-names.

## Core decision: bcm-sourced when present, inference fallback

`buildPathViewModel` gains an optional detail source on `SyncedPath`. **When an enrollment has
`bcm_project_progress` rows, wins + completeness come from the mirror; otherwise the existing
inference path runs unchanged.** The switch is per-path (per-enrollment), silent, and never mixes
the two sources for one path.

## The three product decisions

### 1. What counts as a "win" — **[DECIDED — confirm]**

**All bcm-complete projects are named wins; speech-delivered ones are enriched.** A project with
`complete = true` is a win regardless of whether it was a speech: speech projects show their real
`speechTitle` + `speechDate`; non-speech (leadership) projects show just the project name with a
completion check. Rationale: `/detail` now tells us authoritatively everything the member finished —
celebrating only speeches would hide real accomplishments (leadership projects, Level completions),
and the whole point of Slice 1 was authoritative per-project truth. (Fallback path is unchanged:
without bcm rows, wins remain speech-inferred as today.)

### 2. Speech history surface — **[DECIDED — confirm]**

**No separate "speech history" section in v1 — the enriched wins list *is* the speech history.**
Wins already carry title + date inline; a parallel chronological "history" section would duplicate
that. Wins render grouped by level (matching the progress narrative), each speech win showing
title · date. A dedicated chronological speech-history view is a possible future addition, out of
scope here (YAGNI).

### 3. "Up next" precision with `min_req_electives` — **[DECIDED — confirm]**

`upNext` = current-level catalog projects that are **not bcm-complete**. Required (`is_required`)
projects list individually by name. Electives collapse into one **"Choose N more elective(s)"**
group, where `N = min_req_electives − (electives already complete at this level)`, listing the
remaining pool projects as the choices. When bcm is absent (fallback), `upNext` keeps today's
behavior (current-level catalog minus win-names, no elective-count precision).

## Fallback UX

Silent and identical in layout. When an enrollment has no `bcm_project_progress` rows, the view
renders exactly as today (inferred wins, coarse up-next) with **no apologetic row** and no "less
precise" indicator — per the locked-visual rule in the progression-model spec.

## Read-side design

All changes in `src/server/pathways-read-logic.ts` (pure `buildPathViewModel` stays pure and
testable). No new server-fn module; `pathways-read.ts` (the `createServerFn` wrapper) is untouched.

- **New fetches** (batched, mirroring the existing `fetchDeliveredWins`/`fetchCatalogProjects`
  Promise.all shape — no N+1):
  - `fetchDetailProjects(enrollmentIds)` → `bcm_project_progress` joined to `pathwaysProjects`
    (level, name, isRequired) → `{ courseCode, level, name, isRequired, complete, speechTitle?, speechDate? }`.
  - `fetchPathLevels(pathIds)` → `pathways_path_levels` → `{ courseCode, level, minReqElectives }`.
- **`SyncedPath` gains** `detailProjects?: DetailProjectRow[]` and `pathLevels?: {level, minReqElectives}[]`.
  When `detailProjects` is present and non-empty for a path, `buildPathViewModel` takes the
  bcm branch; otherwise the existing inference branch.
- **`buildPathViewModel` (pure) new branch** when bcm present:
  - `wins` = every `detailProjects` row with `complete === true`, as `{ level, name, speechTitle: title ?? "", deliveredAt: date ?? null }`, sorted by (level, then date/name).
  - `upNext` (only when not complete + has a current level): current-level catalog projects
    (`catalogProjects`) whose name is NOT bcm-complete; required ones individual; electives grouped
    with the computed "choose N" count from `pathLevels`.
  - `ringPercent` / `levels` / `currentLevel` / `complete` are UNCHANGED (still from the count mirror
    `path_level_progress` — the mirror augments, it doesn't replace the ring).
- **Threading:** `pathwaysForPerson` and `pathwaysByMember` capture `pathEnrollments.id` per path
  (already in scope via the join), fetch the two new batches alongside the existing ones, and attach
  `detailProjects` + `pathLevels` to each `SyncedPath` before mapping through `buildPathViewModel`.

## View-model / component changes

- `PathViewModel.wins` keeps its shape (`{ level, name, speechTitle, deliveredAt }`) — non-speech
  wins carry `speechTitle: ""`, `deliveredAt: null`, which the existing `YourWins` already renders as
  a bare name. **Add** a small completion check/indicator for non-speech wins so they don't look
  half-rendered. `UpNext` gains the elective "choose N more" grouping.
- `UpNextProject` gains an optional elective-group representation. Keep the change minimal:
  a `PathViewModel.upNext` entry may be either a named project or a `{ chooseCount, options }`
  elective group; the component renders required projects then the elective group.
- Contrast/theme: all new bits use existing shadcn/Tailwind tokens; verify light + dark
  (text ≥ 4.5:1, indicators ≥ 3:1), consistent with the locked visual's rule.

## Testing

- **`buildPathViewModel` unit tests** (pure, no DB): bcm-present branch (all-complete → wins,
  speech enrichment, non-speech name-only, up-next excludes complete, elective "choose N"
  computation from `minReqElectives` and completed electives); bcm-absent branch (falls back to
  today's inference — existing tests stay green).
- **Integration** (`tm_test`): `pathwaysForPerson`/`pathwaysByMember` return bcm-sourced wins when
  `bcm_project_progress` rows exist for the enrollment, and inferred wins when they don't; batching
  stays one-query-per-concern (no N+1).
- Existing read-logic tests must keep passing (fallback path unchanged).

## Out of scope

- Any schema change (Slice 1 owns the data). A separate chronological speech-history section.
  Roster-level detail columns / VPE dashboards. Reminders. Editing.

## What this closes

- **#121** — wins / up-next / speech titles switch to the `bcm_project_progress` mirror, with
  silent fallback to inference.
