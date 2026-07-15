# ADR-0022: Dated, club-attributed Pathways level completions

Status: Accepted

## Context

CONTEXT.md and ADR-0008 name **club-credit** as the one club-scoped Pathways concept:
paths are Person-owned (club-independent), but a completed **level** is credited to
*one* of the person's clubs. Phases 1–2 (#101 → PRs #112/#115, ADR-0011) built the
count-based mirror and named specificity but deliberately dropped `credited_club_id`
because Base Camp's `/api/bcm/progress` and `/detail` payloads expose **no crediting
club** — and, it turns out, **no completion date** either.

The concrete (and near-term only) consumer is **#245** — DCP auto-derivation of the six
education goals — which counts levels completed **within a program year** (Jul 1 – Jun 30)
**at a given club**. That needs two facts the current schema lacks on `path_level_progress`:
*when* a level was completed and *which club* to credit. #116 was re-scoped to model both.

The governing reality: **Base Camp gives us neither fact.** The sync only ever sees a
level's current `approved: true/false`, and its club-scoping comes solely from *which
club's token* ran it (`sync_tokens.clubId`) against that club's roster. So both facts must
be **inferred at sync time**, not read from Base Camp. This ADR is that inference contract.

## Decision

**Stamp two write-once, nullable columns onto `path_level_progress`, populated only when
the sync *witnesses* a level's `approved` flip false→true.** No new table; the completion
fact lives on the row it describes.

1. **Schema.** Add to `path_level_progress`:
   - `completed_at timestamptz` — the first sync at which this app *observed* the level
     approved. Semantically "first-observed-approved," not Base Camp's true award date.
   - `credited_club_id uuid → clubs.id`, `onDelete: set null` — the club whose sync first
     witnessed the completion. A deleted club drops the attribution but keeps the
     (person-owned) progress row.

   Both are **nullable** and both are **first-observed derived facts** — `path_level_progress`
   is no longer a *pure* Base Camp mirror. This is the deliberate cost of colocating the
   completion fact with the count it belongs to (over a separate `level_completions` event
   table): a level completion fires once in practice, so event-sourcing it was unwarranted.

2. **Date = first witnessed transition (sync wall-clock).** On the sync where
   `approved` flips false→true we stamp `completed_at = now()`. We do **not** derive a
   truer date from `/detail` speech dates — that source is absent for non-detail-syncing
   clubs and a level's approval doesn't map cleanly to one speech date. It is a documented
   future refinement, not the v1 rule.

3. **Crediting club = the syncing club, first-syncer-wins.** `credited_club_id` is set to
   the club whose token ran the witnessing sync. It is the only club value available at
   sync time without inventing a "home club" concept the schema does not have. For a member
   in 2+ clubs this is **approximate** — the first club to sync after approval claims the
   credit even if the speeches were delivered elsewhere — and is accepted as such because
   (a) the common single-club case is unambiguous and (b) #245 surfaces derived goals as
   **editable suggestions** a President can override.

4. **Write-once, never cleared.** Both columns are set only when currently null *and* a
   false→true transition is witnessed. A later `approved` true→false (re-opened level) does
   **not** clear them; a subsequent false→true does **not** re-stamp (the null-guard blocks
   it). The first witnessed completion is canonical forever — monotonic, and it prevents a
   DCP count from flip-flopping or a completion jumping program-year boundaries on churn.

5. **Cold start = null (no fabrication).** A level that is *already approved* the first
   time we ever see the enrollment (the INSERT path) is left **null/null** — we never
   witnessed it complete, so we know neither when nor where. `approved` still tells the
   display layer the level is done; the completion columns mean strictly "a completion this
   app observed happen, here, on this date." DCP counts only non-null `completed_at` in-window.

6. **No backfill.** The migration adds nullable columns; every existing row stays null
   (we have no transition history for already-synced progress). The feature is **forward-only**:
   DCP sees completions only as members finish *new* levels post-deploy. Honest — an
   unwitnessed completion has no defensible date or club — and cheap, since #245 is deferred
   and manually overridable. A one-time `/detail` speech-date backfill is a possible future
   option, explicitly out of scope here.

7. **Mechanism.** The transition is detected **atomically inside the existing per-level
   `onConflictDoUpdate`** in `syncClubProgress` (no read-before-write): a `CASE` sets
   `completed_at = now()` / `credited_club_id = :clubId` only when
   `path_level_progress.approved = false AND excluded.approved = true AND
   path_level_progress.completed_at IS NULL`, else carries existing values forward. The
   INSERT branch leaves both null (rule 5). Row-level `ON CONFLICT` plus the `IS NULL` guard
   makes two clubs concurrently syncing a shared dual-club enrollment resolve to
   first-committed-transition-wins with no extra locking (consistent with the file's existing
   concurrency handling).

8. **Scope boundary.** This ADR / #116 delivers *only* the two columns, the sync-write
   logic, an index on `credited_club_id` to serve #245's query, and tests. The **program-year
   mapping and DCP UI are #245's**; #116 only guarantees the two facts exist to query.

## Consequences

- **#245 is unblocked forward-only:** it can count `path_level_progress` rows where
  `credited_club_id = C` and `completed_at ∈ [program-year window]`, no schema change of its
  own — but sees nothing until post-deploy completions accrue (weeks per club), so its
  manual-entry path remains load-bearing for the first year of any club.
- **`path_level_progress` stops being a pure mirror** — two of its columns are app-observed,
  not Base-Camp-sourced. Documented here and in the CONTEXT.md glossary so a future reader
  doesn't treat them as sync-authoritative.
- **Dual-club attribution can be wrong** (first-syncer-wins), correctable only via #245's
  override — acceptable given single-club is the norm and no home-club concept exists.
- **A future member-facing "you completed Level N, credited to <club>" view** can read these
  columns directly; the model was kept concept-clean for exactly that, though no such UI ships
  now.
- **Promoting to a `level_completions` event table** stays a clean future migration if real
  un-approve/re-approve churn ever appears; today's write-once columns assume it does not.
