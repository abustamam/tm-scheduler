# Pathways `/detail` endpoint — authoritative per-project completion + speeches

Date: 2026-07-07
Issue: #120 (this design). Depends on #107/#119 (extension sync plumbing, landed).
Related: #101 (named specificity), #112/#115 (progression model), #117 (unattended sync).
ADRs: introduces **ADR-0011**; reverses two load-bearing assumptions in
`2026-07-06-pathways-progression-model-design.md`; revisits ADR-0009 (speeches first-class).

## Summary

Base Camp exposes a per-member, per-path **detail** endpoint that returns *project-level* data —
which the shipped progression model explicitly assumed did not exist:

```
GET https://basecamp.toastmasters.org/api/bcm/progress/<course-v1-id>/detail?user=<base-camp-user-guid>&page_size=5000
```

Both `<course-v1-id>` (the `course_id` from the summary sync) and `<base-camp-user-guid>` (the
member's Base Camp **`user.username`** GUID) are already in the summary payload, and the call uses
the same origin/session/auth. It returns two parts:

- **`blocks`** — the full course tree (`course → chapters (Level 1..5, Path Completion) →
  sequentials (projects)`) **for the projects that member has chosen**. Each project carries
  `display_name` and a per-project `complete: true|false`, plus `block_lib_type: "imported" |
  "elective"`. Unchosen electives appear as placeholders (empty `block_id`, generic name like
  `"2nd Elective"`). Chapters carry `complete` and `min_req_electives`.
- **`speeches`** — a map of `<project block_id> → { speech_title, speech_date }`: the member's
  actual speech title + date for projects delivered as speeches.

This overturns two premises in the shipped progression-model spec:

- *"Granularity is per-level counts, not per-project… project identity can never come from Base
  Camp."* → **False.** `blocks[].children[].complete` gives authoritative, named per-project
  completion.
- *"scraping speech-level data (it isn't exposed)."* → **False.** `speeches` gives real titles +
  dates.

## North star (unchanged)

Base Camp remains the system of record for Pathways education. This app mirrors Base Camp and
celebrates wins; it never presents itself as the authority. This design makes the mirror *more
faithful* — authoritative named projects and real speech history, sourced directly from Base Camp
instead of inferred from the member's own logged speeches.

## Core decision: augment, don't replace

The count-based mirror stays as the always-available coarse truth. A new **read-only detail
mirror** layers authoritative named data on top. Concretely:

1. **Count-based mirror stays** (`path_level_progress`) — the truth available before any detail
   sync and the fallback if detail is ever unavailable. Ring %, level bars, and `approved`
   celebration are unchanged.
2. **The hand-seeded catalog stays the pool-of-possible; `/detail` enriches it.** `/detail` cannot
   supply the full elective *pool* — a member's `blocks` only contains the required projects plus
   *their chosen* electives (unchosen electives are anonymous placeholders), so Base Camp never
   enumerates a path's full elective menu in any one member's detail. Therefore:
   - The **hand-seeded catalog** (`pathways-catalog.ts`) remains the source of the full elective
     pool per level — this is what "Up next — choose your next project" needs.
   - `/detail` **stamps `bcm_block_id`** onto the catalog rows it can match, **derives required
     (`imported`) projects** we didn't hand-seed, and **drives per-member `complete` + speech
     data**. It does *not* replace the seed.
3. **A new per-member detail mirror** (`bcm_project_progress`) records authoritative per-project
   `complete` plus the speech title/date Base Camp holds.
4. **Our `speeches` table (ADR-0009) is untouched.** It stays about scheduling / member intent. No
   Base Camp data is ever written into it. The two sources coexist; we do not merge or dedupe a
   Base Camp speech against a member-entered speech.

Rationale for the separate read-only mirror over backfilling `speeches`: our `speeches` are
forward-looking (a member enters a speech to claim a slot, delivered *in our app*), while `/detail`
is a backward-looking authoritative record of what Base Camp has approved. Different lifecycles;
merging them invites drift and overwrite risk. Clean boundaries mean no reconciliation logic.

## Data model

### Catalog — hand seed retained, enriched from `/detail`

```
pathways_projects {
  id,
  path_id → pathways_paths,
  level int (1–5),
  name,
  is_required boolean,        -- UNCHANGED column; derived from block_lib_type when created
                              -- from /detail ("imported"→true, "elective"→false)
  bcm_block_id text NULL UNIQUE,   -- NEW: stamped onto matched rows; null for pool rows no member
                                   -- has chosen yet (unique-when-present)
  sort_order
}

pathways_path_levels {        -- NEW
  id,
  path_id → pathways_paths,
  level int,
  min_req_electives int,      -- from the chapter node in /detail blocks
  UNIQUE(path_id, level)
}
```

**Catalog reconciliation rule** (run per `/detail` payload, upsert-in-place — never wipe/recreate,
because `speeches.project_id` FKs into these `id`s):

- Match a `/detail` project to an existing catalog row by **`(path, level, name)`**; on match,
  **stamp `bcm_block_id`** on that row (keeps the same `id`, so the `speeches.project_id` fallback
  FK is preserved).
- **No catalog match + the project is required (`imported`)** → **create** a catalog row from
  `/detail` (name, level, `is_required=true`, `bcm_block_id`). Safe — nothing FKs to a brand-new
  row.
- **No catalog match by name for an elective** → do **not** silently create (avoids polluting the
  hand-curated elective pool with a possibly-misnamed row); **surface it in the sync result** as an
  unmatched-project report, same discipline as unmatched members.
- **Elective placeholders** (empty `block_id`, e.g. `"2nd Elective"`) are **never** catalog rows —
  they represent an unchosen slot; the requirement count lives in
  `pathways_path_levels.min_req_electives`.
- Hand-seeding from the community PDF is **retained** (it owns the elective pool); `/detail` only
  enriches it.

### Per-member detail mirror (read-only, from Base Camp)

The two-table sketch (`bcm_project_progress` + `bcm_speeches`) collapses into **one** table: the
`speeches` map keys by `block_id`, which *is* a project, so title/date attach one-to-one to a
project row.

```
bcm_project_progress {
  id,
  enrollment_id → path_enrollments,
  project_id    → pathways_projects,   -- resolved via bcm_block_id
  complete      boolean,               -- authoritative from blocks[].children[].complete
  speech_title  text NULL,             -- from the speeches map, when delivered as a speech
  speech_date   timestamptz NULL,
  UNIQUE(enrollment_id, project_id)
}
```

- A project can be `complete` with no speech (leadership / non-speech projects) → title/date null.
- Read-only from the app's perspective; re-derived every sync (see Re-sync semantics).

### Unchanged

`speeches` (ADR-0009), `path_enrollments`, `path_level_progress`, `people.basecamp_user_id`,
`pathways_paths` are unchanged in shape. `path_enrollments` remains the join target for detail rows.

## Identity: numeric `user.id` vs GUID `username`

The real summary payload has **`user.id`** numeric (e.g. `122747`) and **`user.username`** the
GUID. Two identifiers are in play:

- **`user.username` (GUID)** — the `?user=` parameter the extension uses to *make* each `/detail`
  call. **Client-only**; never sent to our server (nothing on our side keys off it).
- **`user.id` (numeric)** — the enrollment join key. It is already what the summary parser stores
  as `people.basecamp_user_id` (`String(row.user.id)`), so the detail payload carries the same
  numeric id and the server resolves it exactly like the summary sync.

## Ingest contract & parser

Extend the existing `POST /api/pathways/ingest` (one Bearer-token contract, one CORS surface) —
**no new endpoint**:

```
Body: {
  basecampClubGuid,
  pages:    BcmProgressPage[],     // unchanged — the summary walk
  details?: BcmDetailPayload[]     // NEW, OPTIONAL
}

BcmDetailPayload = {
  basecampUserId,   // numeric user.id (string) — the enrollment join key
  courseId,         // → courseCode → path
  blocks,           // raw /detail blocks tree
  speeches          // raw /detail speeches map
}
```

- **`details` is optional** for backward compatibility: an older extension build (e.g. the one
  from #119 already in the wild) posts summary-only and behaves exactly as today. No forced client
  upgrade.
- **Parse server-side on the raw payload.** The extension sends raw `blocks` + `speeches`; two new
  pure functions in `-logic.ts` siblings (bundle-leak guard — never imported by client code) do
  the work: one applies the catalog reconciliation rule (stamp/derive `pathways_projects` +
  `pathways_path_levels`); one produces `bcm_project_progress` rows by joining `blocks[].complete`
  with the `speeches` map, resolved to enrollments via `basecampUserId` (numeric) + `courseCode`.
  Keeping the parser server-side (matching the summary path) means one fixture-tested parser rather
  than logic split across the extension and server; the sync is an occasional admin action, so the
  larger raw body is an acceptable trade (gzip the POST if a size limit ever bites).
- **Ordering within a sync:** summary parse first (creates/updates `path_enrollments` +
  `basecamp_user_id`), then catalog reconciliation, then per-member detail rows that FK into those
  enrollments.
- **Reporting:** `SyncResult` gains detail counters — projects stamped, projects derived, members
  with detail (**N of M**), unmatched detail members, and unmatched-by-name elective projects.

## Extension detail fan-out

The content script (from #107/#119) gains a second phase after the summary walk:

- From the raw summary `results` it already holds, enumerate `(user.id numeric, user.username GUID,
  course_id)` per row — the exact member×path set.
- For each, `GET …/api/bcm/progress/<course_id>/detail?user=<username-guid>&page_size=5000` (one
  page each), same origin/session/headers as the summary calls — no new auth path, CORS/token story
  unchanged.
- **Throttle** the fan-out with small bounded concurrency (2–3 in flight).
- POST summary `pages` + collected `details` (tagged with the **numeric** `user.id` + `course_id`)
  in the existing single request → "one button, always-fresh" UX preserved.

### Failure semantics — deliberately different from the summary walk

The summary walk (`walkProgressPages`) is intentionally **all-or-nothing**: any page failure aborts
it, because a missing summary member has *no data at all* (stale/invisible) and the walk is cheap to
retry whole. The detail fan-out is **graceful per-call** instead, and the divergence is justified:

- A member whose detail call fails still has **full count-based data from the summary**, and the UI
  **falls back to today's inference** for them — they are not broken, they just miss the
  authoritative-names upgrade *this* sync; the next sync fixes it.
- With `members × paths` calls, all-or-nothing would let **one member's 500 discard everyone's
  names** — a far worse failure mode than for a single summary walk.

So: a failed detail call omits that member from `details` (never aborts the sync); the result reports
"detail fetched for N of M" so a *systematic* failure is still visible.

This is a **new extension version, sequenced after #119** (landed) — explicitly **not folded into
#119**.

## Re-sync semantics for `bcm_project_progress`

- **Replace-per-enrollment**: for each enrollment present in `details`, delete its existing
  `bcm_project_progress` rows and insert the freshly-derived set (idempotent; no stale rows when a
  member changes a chosen elective).
- **Last-known-good otherwise**: an enrollment **absent** from `details` (its detail call failed
  this run) is **left untouched** — prior rows survive. Combined with graceful failure, names only
  ever move forward or stay put; a flaky sync never *downgrades* a member from authoritative names
  back to inference.
- A member who genuinely leaves a path is cleaned up via the existing `path_enrollments`
  archival/cascade, not by the detail sync.

## PII & security

- **Established rules, carried forward:** raw `.har`/detail captures stay **gitignored** — they
  contain member PII *and* session tokens; **no Base Camp session token is ever persisted**; test
  fixtures are **scrubbed**. Storing speech titles in `bcm_project_progress` is consistent with
  already storing member-entered titles in `speeches` — no new privacy category.

## Testing

- Detail parser, catalog reconciliation, and completion upsert: **integration-tested against a
  scrubbed `/detail` fixture** in the `tm_test` DB, with logic in `*-logic.ts` siblings (the
  `server-modules.guard.test.ts` bundle-leak guard applies).
- Coverage:
  - catalog reconciliation: match-by-`(path, level, name)` stamps `bcm_block_id` on the **same**
    row (FK preserved); required-project-not-in-seed → created; elective-not-matched-by-name →
    reported, not created; placeholders excluded; `min_req_electives` captured.
  - completion upsert: `complete`-without-speech; speech title/date join; unmatched-detail-member
    reporting.
  - **re-sync semantics:** replace-per-enrollment removes a dropped elective's row; an enrollment
    absent from `details` keeps its prior rows (last-known-good).
  - **backward compatibility:** a summary-only payload (no `details`) behaves exactly as today.

## Phasing

- **Slice 1 (this spec's plan) — backend + extension.** Mirror table + catalog-enrichment schema
  (`bcm_block_id`, `pathways_path_levels`), the extended ingest contract, the server-side detail
  parser + reconciliation + upsert, and the extension fan-out. Produces synced authoritative data
  end-to-end, testable, with **no UI change** yet.
- **Slice 2 (fast-follow) — UI switchover.** "Your wins" reads `bcm_project_progress`
  complete+speech; "Up next" = current-level catalog projects not complete, honoring
  `min_req_electives` for elective slots (from the retained hand-seeded pool); a real
  delivered-speech history from the mirror. All read the mirror **when present, falling back to
  today's inference** when an enrollment has no detail rows yet.

## Out of scope

- The UI switchover (Slice 2, above) — direction committed here so the data model is right, but not
  built in Slice 1.
- Extending the manual paste-box fallback to accept detail captures (the extension is the real path;
  manual detail paste is fiddly) — fast-follow if ever needed.
- Reminders/nudges; cross-club analytics; club-credit attribution; catalog editing in-app.

## Documentation deliverables

- **ADR-0011** — "Base Camp `/detail`: authoritative per-project completion + speeches" — records
  the reversal of the two assumptions and the enrich-don't-replace-the-catalog decision (incl. why
  the elective pool stays hand-seeded).
- **Superseding note** appended to `2026-07-06-pathways-progression-model-design.md` pointing to
  this spec for the two reversed premises.
