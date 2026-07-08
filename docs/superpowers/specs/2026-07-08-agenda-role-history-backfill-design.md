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

**~75% is sufficient; more is better.** This is a one-time backfill of
historical data, not a system of record. We do NOT fabricate matches to hit
100%. Unmatched names, unreadable files, and ambiguous rows are **reported and
skipped**, never guessed into the database.

## Source data

Drive folder `1MkX1A_OK2HlSiTHa2EAQMwkd5o5TmB29`: ~40 agenda files, meetings
#1–#55, Jan 2024 → Jul 2026. Heterogeneous:

| Type | Count (approx) | Handling |
| --- | --- | --- |
| Google Docs (`vnd.google-apps.document`) | ~30 | Primary — clean text extract |
| Word (`.docx`) | 3 (#3, #29, #31) | Readable via Drive tool |
| Shortcuts (`vnd.google-apps.shortcut`) | ~10 | Resolve target where easy; else skip |
| JPEG (#35 speech competition) | 1 | Best-effort vision; else skip |
| Subfolders (slides, Archive) | 2 | Ignore |

Verified extract of a native Doc yields, reliably:

- **Roles table** (markdown): `Toastmaster | <name>`, `Speaker #1..3 | <name>`,
  `Evaluator #1..3 | <name>`, `General Evaluator`, `TableTopic Master`,
  `Grammarian/WOD`, `Ah Counter`, `Timer`, `Vote Counter`.
- **Speaker detail lines**:
  `Speaker #1 - Jagpal Singh - Level 2: Effective Body Language ... "Leadership in the Era of AI"`
  → speaker name, project level, project name, speech title.
- **Evaluator pairings**: `Sudheer Isanaka for Jagpal Singh`.
- **Footer**: club #, meeting number, meeting date, theme, Word of the Day.

Blank cells are common (upcoming/partly-filled agendas) → skipped.

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

- **`meetings`** — `clubId`, `scheduledAt` = meeting date at the club's start
  time, `status: "completed"`, `theme`, `wordOfTheDay`. **Idempotency key:
  (clubId, scheduledAt::date)** — upsert, so re-runs never duplicate. (Meeting
  number is not a column; date is the natural key and is unique per club.)
- **`role_slots`** — one per filled role. Agenda label → the club's
  `role_definitions` (matched by name at runtime, see mapping below);
  `Speaker #1/2/3` → `slotIndex` 0/1/2, same for `Evaluator #1/2/3`.
  `assignedMemberId` = matched member, `status: "confirmed"`,
  `claimedAt` = meeting date. Idempotency: delete-and-reinsert this meeting's
  slots on re-run (a meeting's slot set is fully derived from its agenda).
- **`speeches`** — for each filled speaker slot with detail: person-owned
  (`personId` from the matched member), `title`, `projectLevel`, `projectName`.
  Linked via `role_slots.speech_id`. `pathwayPath` left null (agendas don't
  reliably name the path). **Idempotency (important):** because slots are
  delete-and-reinserted per meeting (below), the speech itself must NOT be tied
  to slot lifetime — reuse an existing speech keyed on **(personId, normalized
  title)**, else create one; then link the freshly-inserted slot to it. This
  prevents duplicate speeches across re-runs (deleting a slot only nulls the
  pointer; the durable, person-owned speech survives per ADR-0009).
- **Evaluator pairing** — `evaluates: "Speaker #N"` sets the evaluator slot's
  `evaluatesSlotId` to that meeting's Speaker-#N slot.

### Name matching

A `matchMember(name, roster)` helper:

1. Normalize (lowercase, trim, collapse whitespace, strip trailing `(G)` guest
   marker).
2. Exact normalized match against club `members` (active + inactive — inactive
   members keep their history, `schema.ts` members comment).
3. Hand-editable **alias map** (`ref/agendas/aliases.json`) for known short
   forms seen in the data: `Saif→Saiful Haque`, `Farha Begum→Farhanaaz Begum`,
   `Dina→Mahbuba Khan`, etc.
4. No match → record in the **unmatched report** and **skip that row**. Guests
   `(G)` are expected misses and are skipped silently (counted, not errored).

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
| **Vote Counter** | *(none seeded)* | — skip + report |
| **Sergeant at Arms** | *(none seeded)* | — skip + report |

Labels with no matching role definition are **reported and skipped**. If the
user wants Vote Counter / Sergeant at Arms history, they add those role
definitions first, then re-run.

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

## Open questions

- None blocking. Defaults chosen: roles + speeches scope, dry-run→prod,
  skip-and-report on any ambiguity.
