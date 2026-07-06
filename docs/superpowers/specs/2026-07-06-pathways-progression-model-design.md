# Pathways progression model — design

Date: 2026-07-06
Issues: closes #61 (data-driven progress UI); closes #101 (speech→project modeling, Phase 2);
follow-up #107 (browser-extension auto-sync).
ADRs referenced: ADR-0008 (person identity), ADR-0009 (speeches first-class). Extends CONTEXT.md "Pathways".

## North star

**Base Camp is the system of record for Pathways education. This app is a scheduling app with a
nice UI that celebrates wins and drives members back to Base Camp.** We never present ourselves
as the authority on education progress — we mirror Base Camp and nudge. A member's only real
inputs here remain: entering their speech (to claim a speaker slot) and confirming roles.

## What Base Camp actually gives us (verified from real data)

The Base Camp Manager dashboard calls a JSON endpoint (captured in `samples/_api_bcm_progress_*`):

```
GET https://basecamp.toastmasters.org/api/bcm/progress/?club=<club-guid>&page=N   (paginated)
```

Per member, per path:
```json
{ "user": { "id": 122747, "name": "...", "email": "...", "username": "<guid>" },
  "path_name": "Presentation Mastery",
  "course_id": "course-v1:Toastmasters+8701+8_15_2023",
  "progression": {
    "Level 1": { "completed": 5, "total": 5, "approved": true },
    "Level 4": { "completed": 2, "total": 3, "approved": false },
    "Path Completion": { "completed": 0, "total": 1 } } }
```

Decisive facts this establishes:

- **Granularity is per-*level* counts, not per-*project*.** Base Camp tells us "Level 4: 2 of 3,"
  never *which* two. So project *identity* can never come from Base Camp.
- **`approved` per level is the authoritative award signal** — free, no manual award flow needed.
- **`course_id` carries a stable path code** (8701 = Presentation Mastery, 8700 = Motivational
  Strategies, 8711 = Engaging Humor, 8705 = Strategic Relationships, 8706 = Dynamic Leadership,
  8702 = Leadership Development, …). This is the durable catalog key — not the display name.
- **Identity keys are `email` + Base Camp `user.id`/`username` GUID. There is no `PN-` Customer ID.**
- **Multi-path** = the same `user.id` appears on multiple path rows.
- **Data quirks to handle:** `completed` can **exceed** `total` (e.g. `Level 3: 7 of 3` — extra/
  repeated electives); per-level `total` **varies by path**; treat **`approved`**, not
  `completed == total`, as the real "level done" signal; the endpoint is **paginated** and
  **per-club**.

⚠️ **Security/PII:** the captured `.har` files contain live session tokens — must not be
committed. `samples/` stays gitignored (or scrubbed). No Base Camp session token is ever
persisted by this app.

## Core model decision: count-based mirror, names layered on top

Progress is modeled as **Base Camp's per-level counts + `approved`**, synced authoritatively.
Project **names** (for celebration and next-step specificity) come from two honest sources —
the static **catalog** and the member's **own speeches** — never from a guess about Base Camp.
The count and the names coexist on screen without being forced to reconcile, so the UI never
implies we've lost track of anything.

## Member view (locked visual)

Ring (path %) + level chips showing `approved`, and for the current level:

- **"Level N · X of Y complete"** — a plain progress bar straight from Base Camp's count.
- **"Your wins"** 🏆 — the specific projects we *can* name, from the member's delivered speeches
  linked to catalog projects. Pure celebration; only shows what we genuinely know.
- **"Up next — choose your next project"** — specific catalog project names in the current level
  that aren't already a named win, presented as choices (electives are a real choice), with
  "do it in Base Camp — it'll sync here."
- Celebration line on `approved` (e.g. "🎉 Level 3 approved — you're 1 project from Level 5!").

No apologetic "1 more in Base Camp — which was it?" row. No member "mark complete" checkboxes.
No "add a project" button (v1). Multi-path = a tab switcher (hidden when a member has one path).
Contrast: all colors map to the app's shadcn/Tailwind tokens; verified in light and dark
(text ≥ 4.5:1, pills/ring/bars ≥ 3:1).

## Data model

### Catalog (static reference data)

```
pathways_paths     { id, course_code (from course_id, e.g. "8701"), name,
                     status: 'current' | 'legacy', sort_order }     -- keyed by course_code
pathways_projects  { id, path_id → pathways_paths, level int (1–5), name,
                     is_required boolean, sort_order }              -- names for wins / up-next
```

`pathways_paths` is needed from Phase 1 (to resolve `course_id` → a path). `pathways_projects`
(project *names*) is a Phase 2 need (celebration/up-next specificity). Per-level `total` counts
come from the **sync**, not the seed. Hand-seeded once from the community catalog PDF; changes
rarely. No `electives_required` rule as hard logic — Base Camp's count/`approved` drives level
completion; `is_required` is display emphasis only.

### Synced progress (authoritative, from Base Camp)

```
path_enrollments    { id, person_id → people, path_id → pathways_paths,
                      basecamp_user_id, last_synced_at, archived_at? }
path_level_progress { id, enrollment_id → path_enrollments, level int (1–5),
                      completed int, total int, approved boolean }
```

One `path_enrollments` row per (person, path); `path_level_progress` mirrors the `progression`
object. `basecamp_user_id` is stored on first match and becomes the durable join key.

### Named wins (specific, from our own data — Phase 2)

```
speeches.project_id → pathways_projects   -- nullable FK (this is #101's payload)
```

"Your wins" = the person's **delivered** speeches whose `project_id` is in the path. This needs
`speeches` (#79) and the FK migration off today's free-text `pathway_path`/`project_name`.

**Dropped from the earlier draft** (superseded by the real data): `project_completions`,
`level_completions`, member manual project-ticking, manual VPE award UI, `electives_required`
logic, and `credited_club_id` (club-credit — Base Camp owns level approval/credit and the API
doesn't expose a per-club chooser; out of scope for v1).

## Ingest / sync

- **v1 — manual JSON ingest.** An admin/VPE screen with a **paste-or-upload box** that accepts the
  raw `/api/bcm/progress` JSON (all pages). The screen shows **clear step-by-step instructions**:
  which Base Camp Manager page to open, how to capture the JSON for each page, and that it's
  per-club. Parsing upserts `pathways_paths` (by `course_code`), `path_enrollments`, and
  `path_level_progress` for matched members.
- **Identity match:** email (case-insensitive) on first sync per ADR-0008's email-fallback; on
  match, persist the Base Camp `user.id`/GUID on the person and match on it thereafter (survives
  email changes). **Unmatched rows are skipped and surfaced in an "unmatched — N rows" report** —
  never auto-create people (avoids roster pollution).
- **Fast-follow — browser extension (#107):** automates the *same* server ingest endpoint using
  the VPE's Base Camp session. No new server contract; the manual box stays as fallback.

## Derived display logic (no stored progress status beyond the synced mirror)

- **Level done** = `approved` (not `completed == total`).
- **Ring %** = Σ min(completed, total) ÷ Σ total across levels, capped at 100% (handles
  `completed > total`).
- **Your wins** = delivered speeches with `project_id` in the path (Phase 2).
- **Up next** = current level's catalog projects not already a named win, shown as choices.
- **Current level** = lowest level not `approved`.

## Prerequisites & phasing

Dependencies are now split, enabling a leaner first ship:

- **Phase 1 — Sync + count-based celebration (needs #64 `people` only).**
  `pathways_paths` seed (course codes) + manual JSON ingest + identity match + the member view
  in count form (ring, level bars, `approved` celebration, "N of M"), member-detail Pathways tab,
  roster Pathway/level column, and dashboard tile. Fully honest and shippable without speeches.
- **Phase 2 — Named specificity (needs #79 `speeches` + closes #101).**
  `pathways_projects` name seed + `speeches.project_id` FK + free-text migration → "Your wins"
  and named "Up next." This is the specificity layer of the locked visual.

(#64 and #79 are Accepted-but-unbuilt ADRs; both OPEN. Phase 1 unblocks the moment #64 lands.)

## Testing

- Ingest parser + identity match + upsert: unit/integration-tested against the real
  `samples/_api_bcm_progress_*` fixtures (scrubbed) using the `tm_test` DB — logic lives in a
  `*-logic.ts` sibling, never imported by client code (server-modules bundle-leak guard).
  Cover: pagination concat, `course_id`→`course_code` parse, `completed > total`, per-path total
  variance, `approved` levels, email→GUID match precedence, unmatched-row reporting.
- Ring/level/up-next derivation and the Phase 2 speech→project migration resolver.

## Out of scope

- Reminders/nudges scheduling; catalog editing in-app; cross-club analytics; club-credit
  attribution; scraping speech-level data from Base Camp (it isn't exposed); the browser
  extension (#107).

## What this closes

- **#61** — data-driven progress model + restored, celebratory progress UI (Phases 1–2).
- **#101** — paths/projects first-class + speech→project FK + free-text migration (Phase 2).
- **#107** — filed as the extension fast-follow.
