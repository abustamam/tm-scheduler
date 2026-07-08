# Agenda role-history backfill — design

**Date:** 2026-07-08
**Status:** Draft (awaiting review)
**Related:** `src/db/schema.ts` (meetings / role_slots / speeches), `scripts/import-members.ts` (precedent)

## Problem

The Base Camp Pathways sync (extension) brings in Pathways *progress* but has no
notion of **who did which role, and when**, or **who gave which speech**. That
history only exists in ~2 years of meeting agendas (Google Docs in a shared
Drive folder). We want that history in GavelUp so member profiles and the
scheduler can answer "when did X last take role Y?" and "what has X spoken?".

The data model already treats this as history: `role_slots.ts` comment —
*"this table IS the history: who-has-done-what is a query over slots of past
meetings."* So backfilling = creating past `meetings` + `role_slots` (+
`speeches`) rows. **No schema changes.**

## Accuracy bar

**~70% is sufficient; more is better** (lowered from 75% once shortcuts were
ruled out — see Source data). This is a one-time backfill of historical data,
not a system of record. We do NOT fabricate matches to hit 100%. Unmatched
names, unreadable files, and ambiguous rows are **reported and skipped**, never
guessed into the database. The one sanctioned automatic inference is a
high-confidence typo correction (unique roster candidate at edit-distance ≤1 —
see Name matching), which is a correction, not a guess.

## Source data

Drive folder `1MkX1A_OK2HlSiTHa2EAQMwkd5o5TmB29`: ~40 agenda files, meetings
#1–#55, Jan 2024 → Jul 2026. Heterogeneous:

| Type | Count (approx) | Handling |
| --- | --- | --- |
| Google Docs (`vnd.google-apps.document`) | ~30 | Primary — clean text extract |
| Word (`.docx`) | 3 (#3, #29, #31) | Readable via Drive tool (**verified**) |
| Shortcuts (`vnd.google-apps.shortcut`) | ~13 (#1,2,4,5,37–39,42,43,48–50,54) | **Skipped** — see below |
| JPEG (#35 speech competition) | 1 | Best-effort vision; else skip |
| Subfolders (slides, Archive) | 2 | Ignore |

**Shortcuts are skipped (decision).** The Drive MCP tools cannot resolve a
shortcut to its target: `read_file_content` on a shortcut returns `{}` and
metadata carries no `shortcutDetails.targetId`. Resolving them would mean either
manual conversion in Drive or a fragile `/browse` scrape. Per the user, we skip
them and **accept ~72% meeting coverage** (bar lowered from 75%). The ~13 lost
meetings are among the earliest.

Verified extract (Doc **and** .docx) yields, reliably:

- **Roles table** (markdown). Column layout drifts across years (older agendas
  use an "Evaluations:" header cell, misspell "Voter Counter", leave cells
  blank), which is exactly why extraction is agent-read, not regex-parsed.
- **Speaker detail lines** — two shapes seen:
  - newer: `Speaker #1 - Jagpal Singh - Level 2: Effective Body Language ... "Leadership in the Era of AI"` (name, level, project, title)
  - older: `Speaker #1 - Faisal Ali | Time 5-7 mins "The day I became a scribe"` (**name + title only — no level/project**)
- **Evaluator pairings**: `Sudheer Isanaka for Jagpal Singh`.
- **Footer**: club #, meeting number, meeting date, theme, Word of the Day.

Blank cells are common (upcoming/partly-filled agendas) → skipped. Source names
contain typos (e.g. "Jaqpal" for Jagpal) and guest markers ("Hana Haque (G)").

## Approach: extract (agent) → review (human) → import (tested script)

The pipeline splits on its natural seam: **fuzzy judgment** (reading
heterogeneous docs, matching names) vs **deterministic write** (inserting rows).

### Stage 1 — Extraction (agent, not a code parser)

Claude reads each doc via the Drive tool and emits **one JSON record per
meeting** into a reviewable dataset (`ref/agendas/*.json`, one file per meeting,
plus an `index.json`). Reading-based extraction absorbs the format
heterogeneity (Docs, .docx, image) that a regex parser would choke on, and this
is a one-time job so "repeatable without Claude" has no value.

Per-meeting record shape:

```jsonc
{
  "meetingNumber": 55,
  "date": "2026-07-09",          // from filename + footer
  "theme": "Unity",
  "wordOfTheDay": "Momentum",
  "roles": [
    { "label": "Toastmaster", "name": "Faisal Ali" },
    { "label": "Speaker #1", "name": "Jagpal Singh",
      "speech": { "title": "Leadership in the Era of AI",
                  "projectLevel": "Level 2",
                  "projectName": "Effective Body Language" } },
    { "label": "Evaluator #1", "name": "Sudheer Isanaka", "evaluates": "Speaker #1" }
    // ...only FILLED rows; blanks omitted
  ],
  "sourceFileId": "13FAdX...",
  "sourceTitle": "55th_Meeting_MCF_Agenda_7-09-26"
}
```

### Stage 2 — Review (human)

The importer runs **`--dry-run` by default** and prints exactly what it would
do: meetings to insert/update, slot+speech counts, and — critically — the
**unmatched-name report**. The user eyeballs the diff, fixes aliases (Stage 3)
or JSON, and re-runs. Nothing is written until `--commit` is passed.

### Stage 3 — Import (`scripts/import-agendas.ts`)

Mirrors `scripts/import-members.ts` (standalone Bun script, `#/db`, dotenv).
Deterministic and unit-testable. Reads `ref/agendas/*.json` and writes:

- **`meetings`** — `clubId`, `scheduledAt` = meeting date (from the **footer**
  "Meeting Date"; filename date as fallback) at the club's 6:45 PM start,
  `lengthMinutes: 60` (agendas run 6:45–7:45, not the 90 default),
  `status: "completed"`, `theme`, `wordOfTheDay`. **Idempotency key:
  (clubId, scheduledAt::date)** — upsert, so re-runs never duplicate. (Meeting
  number is not a column; date is the natural key and is unique per club.)
  Re-runs only touch meetings whose date appears in the extracted dataset, so
  they never disturb meetings created natively in-app. **Caveat:** manual
  in-app edits to a *backfilled* historical meeting are overwritten on re-run.
- **`role_slots`** — one per filled role. Agenda label → the club's
  `role_definitions` (matched by name at runtime, see mapping below);
  `Speaker #1/2/3` → `slotIndex` 0/1/2, same for `Evaluator #1/2/3`.
  `assignedMemberId` = matched member, `status: "confirmed"`,
  `claimedAt` = meeting date. Idempotency: delete-and-reinsert this meeting's
  slots on re-run (a meeting's slot set is fully derived from its agenda).
- **`speeches`** — for each filled speaker slot with a speech: person-owned
  (`personId` from the matched member), `title` (required — the one field always
  present), `projectLevel`/`projectName` **when present** (older agendas give a
  title only → these stay null). Linked via `role_slots.speech_id`.
  `pathwayPath` left null (agendas don't reliably name the path). A speaker slot
  with a matched member but no parseable speech line is still created (assignment
  history) with no linked speech. **Idempotency (important):** because slots are
  delete-and-reinserted per meeting (below), the speech itself must NOT be tied
  to slot lifetime — reuse an existing speech keyed on **(personId, normalized
  title)**, else create one; then link the freshly-inserted slot to it. This
  prevents duplicate speeches across re-runs (deleting a slot only nulls the
  pointer; the durable, person-owned speech survives per ADR-0009).
- **Evaluator pairing** — `evaluates: "Speaker #N"` sets the evaluator slot's
  `evaluatesSlotId` to that meeting's Speaker-#N slot.

### Name matching

A `matchMember(name, roster)` helper, in priority order:

1. Normalize (lowercase, trim, collapse whitespace, **strip trailing `(G)` guest
   marker** then match normally — a former guest who has since joined links to
   their roster row; a true outsider simply won't match and is skipped. No
   guest special-casing, no placeholder `people` rows).
2. Exact normalized match against club `members` (active + inactive — inactive
   members keep their history, `schema.ts` members comment).
3. Hand-editable **alias map** (`ref/agendas/aliases.json`), pre-seeded with the
   short forms already seen: `Saif→Saiful Haque`, `Farha Begum→Farhanaaz Begum`,
   `Dina→Mahbuba Khan`, etc.
4. **Fuzzy typo correction — auto-applied only when safe:** a single unique
   roster candidate at Levenshtein distance ≤1 (e.g. `Jaqpal→Jagpal`) links
   automatically. Two-or-more candidates, or distance ≥2, do NOT auto-link.
5. No match → record in the **unmatched report** (with any near-miss candidates
   at distance ≤2 listed as suggestions for the human to add to the alias map)
   and **skip that row**.

### Role-label mapping

Fixed table agenda-label → `role_definitions.name`, resolved against the club's
actual definitions at runtime:

| Agenda label | Role definition | slotIndex |
| --- | --- | --- |
| Toastmaster | Toastmaster of the Day | 0 |
| Speaker #1/#2/#3 | Speaker | 0/1/2 |
| Evaluator #1/#2/#3 | Evaluator | 0/1/2 |
| General Evaluator | General Evaluator | 0 |
| TableTopic Master | Table Topics Master | 0 |
| Grammarian/WOD | Grammarian | 0 |
| Ah Counter | Ah-Counter | 0 |
| Timer | Timer | 0 |
| Vote Counter *(and "Voter Counter" typo)* | Vote Counter — **created if missing** | 0 |
| Sergeant at Arms | *(officer position — out of scope)* | — |

The importer **creates a "Vote Counter" functionary `role_definition` if the
club lacks one** (idempotent), then maps to it — Vote Counter is filled on
nearly every agenda, so it's worth capturing. "Sergeant at Arms" is an officer
position (belongs to `officer_terms`, out of scope) and lives in the officer
list, not reliably in the roles table — it is not imported as a per-meeting
slot. Any *other* unmapped label is reported and skipped.

## Components & boundaries

- `scripts/import-agendas.ts` — CLI entry: reads JSON, `--dry-run`/`--commit`,
  prints report. Thin; delegates to logic module.
- `scripts/import-agendas-logic.ts` — pure, testable: JSON record + roster +
  role defs → planned writes (meetings/slots/speeches) + unmatched report.
  Unit-tested with fixtures (no DB).
- `ref/agendas/*.json` — extracted dataset (committed data, reviewed by human).
- `ref/agendas/aliases.json` — name alias map (hand-editable).

The DB-touching script imports `#/db` directly (like `import-members.ts`); it is
never imported by client code, so no bundle-leak concern.

## Testing

- Unit tests on `import-agendas-logic.ts` with 2–3 fixture records covering:
  filled/blank rows, speaker+speech, evaluator pairing, unmatched name, unmapped
  role label, guest `(G)`.
- Manual: `--dry-run` against prod, review report, `--commit`, spot-check a
  couple of meetings in the app.

## Run target & safety

**Dry-run first, then prod** (default). Idempotent, so re-runs after fixing
aliases are safe. No local-DB round-trip required (the dry-run report is the
safety gate).

## Out of scope (possible follow-ups)

- **Officer-term history** — agendas list President/VPE/etc.; that's the
  `officer_terms` table, a separate backfill.
- Meeting timings / boilerplate agenda script lines.
- Any live/repeatable importer (this is a one-time backfill).

## Resolved decisions (grilling, 2026-07-08)

- **Scope:** roles + speeches. **Target:** dry-run → prod.
- **Shortcuts (~13 meetings):** skipped; coverage bar lowered to ~70%.
- **Name typos:** auto-correct only at unique-candidate distance ≤1; else report
  near-misses & skip.
- **Guests `(G)`:** strip marker, match normally, keep if on roster today, else
  skip (no placeholder people).
- **Vote Counter:** captured; role definition created if missing. **Sergeant at
  Arms:** out of scope (officer position).
- **Meeting:** date from footer (filename fallback), `lengthMinutes` 60,
  status `completed`.
- **Speeches:** title required; level/project nullable; slot created even with
  no parseable speech line.

No open blockers.
