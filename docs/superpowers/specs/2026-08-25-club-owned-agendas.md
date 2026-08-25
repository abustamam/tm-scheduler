# Club-owned agendas — design

**Issue:** [#622](https://github.com/abustamam/tm-scheduler/issues/622)
**Depends on:** #621 (shipped as v1.25.0.0), v1.25.1.0
**Supersedes:** the "Phase 2" sketch in `2026-08-24-agenda-editor-design.md`
**Status:** ready for `/plan-eng-review`

Grilled 2026-08-25. Nine decisions, D1–D9 below. Two of them (D7, D8) exist because
grilling found gaps the issue did not name, and both would have falsified the issue's
central promise that day one looks identical to today.

---

## Problem

An ordinary club meeting's agenda cannot be edited at all. `loadAgendaDraft` is one
line — `if (!meeting?.templateId) return null` (`meeting-agenda-edit-logic.ts:166`) —
and the route redirects away. So everything v1.25.0.0 shipped (the table, the running
clock, per-section subtotals) applies only to meetings that have a template. In the dev
database that is **1 meeting of 12**. The contest works; the other eleven Mondays do not.

The entire per-club customisation surface today is one boolean,
`clubs.ge_introduces_functionaries`.

Second half of the same problem: an edit made through the v1.24.0.0 editor lands on a
private copy (`meeting_templates.meeting_id` set) and is thrown away. Nothing promotes it
into something reusable, so a club redoes the work every week.

### What the standard flow actually is

Measured, not estimated (`buildRunOfShow`, this branch):

| Variant | Beats | Hand-offs | Fixed minutes | Token-bearing details |
|---|---|---|---|---|
| `geIntroducesFunctionaries: false` | 22 | 4 | 46 | 10 |
| `geIntroducesFunctionaries: true` (MCF) | 23 | 5 | 46 | 11 |

The issue says "~25 beats". It is 22/23. Six `handoff: true` declarations exist in source
but some sit behind conditionals, so a rendered variant carries 4 or 5.

"Fixed minutes" excludes the speaker and evaluator beats, which fan out per slot.

---

## What 622a ships

Ordinary meetings become editable. Nothing is reusable yet.

- **First edit materialises a private per-meeting template** from `RUN_OF_SHOW`, expanded
  with the club's current role set and its GE variant (D3).
- **Five section bands** emitted by the materialiser (D2).
- **The template path learns the token vocabulary** (D7).
- **`meeting_template_beats.handoff`** (D8).
- **A cap on `copyTemplateForMeeting`'s source read** (D10).

At the end of 622a an officer can open any Monday and re-time it, and the printed sheet
on day one is byte-identical to what it prints today.

## What 622b ships

Club-wide reuse.

- **Save as club template** — copy the private row into one with `meeting_id NULL` and
  `club_id` set.
- **`clubs.default_template_id`** (D6).
- **`/club/$clubId/agendas`** — list, edit, duplicate, set default, disable.
- **The three notices** (D1, D4, D5).

## What neither ships

- Beat gating in any form (D1).
- A per-row "hide when unstaffed" flag — rejected, see D1.
- A separate club-agenda table, or a per-club minutes-override JSON. Both rejected in the
  issue: no reordering and no new rows makes it a dead end for a templater.
- An editor control for `handoff`. D8 preserves it through adoption; exposing it is
  separate work.

---

## Already done — do not rebuild

Grilling found three ship-list items that already exist. Verify before touching them.

- **Per-meeting template selection.** `MeetingTemplateDialog` exists and
  `listTemplatesForClub` already unions global and club-owned rows while excluding
  per-meeting forks:
  ```ts
  isNull(meetingTemplates.meetingId),
  or(isNull(meetingTemplates.clubId), eq(meetingTemplates.clubId, clubId))
  ```
  (`meeting-templates-logic.ts:115`, and the same predicate at
  `meeting-agenda-edit-logic.ts:831` and `:319`.) A club-owned template appears in the picker with
  **no change to the picker**.
- **Disable.** `enabled` is a column and the same query already filters
  `eq(meetingTemplates.enabled, true)`.
- **The three-state model.** `meeting_templates` already distinguishes global
  (`club_id NULL, meeting_id NULL`), club-owned (`club_id` set, `meeting_id NULL`) and
  private fork (both set). No table is needed.

---

## Decisions

### D1 — Adoption freezes the role gating, and nothing un-freezes it

The standard flow carries 18 gating declarations (14 `requiresAnyOf`, 3 `requiresGroup`,
1 `alsoRequiresGroup`). The gate tests **slot existence**, not staffing — `hasRole` is
`slots.some(matchesRole(...))` and a `role_slots` row exists with a null holder. So
gating means "does this club run this role", which is stable week to week. That is why
adoption can bake it in and day one still matches.

Once adopted, **a row stays until deleted**:

- **Removing a club role** offers to delete its agenda rows and names them first.
- **Adding a club role does nothing to an adopted agenda.** The role-creation screen says
  so plainly and links to the agenda editor.

Rejected: a per-row "hide when unstaffed" flag, and auto-hiding an unheld row. Both
reintroduce invisible authoring — a deleted row becomes indistinguishable from one that
was never generated, which is the argument `agenda-template-rows.ts`' own docblock makes.

Also rejected: offering to insert the new role's rows. Removal knows where a row already
is; insertion has to guess a position in a document the officer has since reordered.

**Distinct from "nobody signed up this week"**, which v1.24.0.0 already settled: the row
prints with an empty holder.

**Consequence, deliberate:** `renderUnowned` becomes dead for adopted agendas. It exists
only to override gating, and there is no gating left to override.

### D2 — Adoption emits five section bands

The standard flow emits **zero** `section` rows. Without bands an adopted agenda loses
#621's per-section subtotals, which is the one number that says where an hour went.

Five bands: **Opening / Speeches / Table Topics / Evaluations / Closing.**

Chosen because they separate speaking (Speeches, Table Topics) from overhead (Opening,
Evaluations, Closing), which is the question that started this work: *"a lot of the
non-speaking parts take almost a whole hour in itself."*

Bands are ordinary rows (`kind: "section"`), so an officer can rename, move or delete
them afterwards. This picks the starting set only.

Rejected: three coarse bands (Opening/Programme/Closing) — "Programme 60" collapses the
exact distinction being measured. Rejected: a sixth band splitting functionary reports
out of Evaluations — a finer distinction than most clubs draw, and every band is another
row to look at.

**Boundaries.** Only five beats carry a stable `id`, so most boundaries cannot be
anchored by id. The materialiser walks the beat list and opens a band at these
transitions. Golden output for both variants, by index:

| Band | `geIntro: false` (22 beats) | `geIntro: true` (23 beats) |
|---|---|---|
| OPENING | 0–3 | 0–4 |
| SPEECHES | 4–6 | 5–7 |
| TABLE TOPICS | 7–9 | 8–10 |
| EVALUATIONS | 10–17 | 11–18 |
| CLOSING | 18–21 | 19–22 |

Each band except OPENING opens on the hand-off that introduces its segment. EVALUATIONS
opens on `geEvaluationHandoff` (index 10 / 11), which is the one boundary with a stable
id and should be anchored on it. CLOSING opens on the Toastmaster's Awards beat.

These two tables are the acceptance criteria for the materialiser. A test asserting only
"five sections exist" would pass with every boundary wrong.

### D3 — First edit forks privately; club-wide reuse is a separate act

Opening an ordinary meeting's agenda and editing it materialises `RUN_OF_SHOW` into a
**private per-meeting template**, exactly as editing a templated meeting already does.

This keeps the distinction that matters: *fix this Monday* is not *change how our club
runs*. A one-off tweak for a visiting speaker must not silently rewrite every future
meeting.

Rejected: prompting to adopt club-wide on first edit — it turns a per-meeting impulse
into a club-wide artifact at the moment the officer is thinking about one evening.
Rejected: requiring adoption from a settings page first — friction at the moment of need
is how the v1.24.0.0 editor ended up unused.

### D4 — A private fork beats a newly-set default, and the club is told

With D3, every meeting anyone has tweaked has a fork, so this is the norm for an active
club rather than an edge case.

Setting a club default:

- A future meeting with **no fork** takes the new default. There is no work to lose.
- A future meeting **with a fork keeps its fork.**
- Setting the default **names the upcoming meetings that kept theirs.**

The naming is not decoration. Without it an officer sets a default, sees next Monday
unchanged, and concludes the feature is broken.

Rejected: the default wins and forks are discarded — that destroys deliberate work with
no undo, which is the exact failure shape v1.25.1.0 shipped a fix for. Rejected: asking
per meeting — one settings click becomes an N-question interrogation, and the honest
answer for most officers is "I don't remember what I changed on October 12th."

### D5 — The GE checkbox becomes disabled-with-explanation once adopted

`club-settings.tsx:387` renders a live checkbox, "General Evaluator introduces the
functionaries". It feeds nothing but agenda shape (`resolveAgendaRows`, print, present),
so after adoption it cannot change anything.

It becomes **state-dependent**: live for clubs that have not adopted, disabled with an
explanation and a link to the agenda editor for those that have. It is not removed —
clubs that never adopt still need it, and someone who set it a year ago must be able to
find out where the behaviour went.

MCF has this set to `true`, so the maintainer's own club hits this on day one.

Rejected: offering to add/remove the `geOpeningHandoff` row. More defensible here than
for a new role because it maps to one known beat, but if the officer has already moved or
deleted that row, "remove it" is ambiguous.

### D6 — The default lives on the club, not the template

`clubs.default_template_id`, nullable FK to `meeting_templates(id)`, **ON DELETE SET
NULL**.

One row per club, so "exactly one default" is true by construction with no index to
enforce it, and deleting the default template nulls the pointer instead of orphaning.

Rejected: `meeting_templates.is_default`. It needs a partial unique index
(`WHERE is_default`), and CLAUDE.md records that `db:push` does **not** update a partial
index's `WHERE` predicate — that trap already cost a debugging session on
`role_definitions_club_key_unique`, where the test database enforced a constraint the
schema no longer declared.

Rejected: "first enabled club template by `sort_order` wins" — reordering the list would
silently change which agenda new meetings get, and there is nowhere to record "this club
has deliberately chosen no default".

### D7 — The template path learns the token vocabulary

**This gap is not in the issue and it is the largest single piece of work in 622a.**

Beat details carry tokens resolved at render time: `{names:<roleKey>}`
(`agenda-runsheet.ts:561`), `{role:<key>}`, `{roles}`, `{awards}`. The standard variant
has 10 such details; MCF's has 11.

The template path stores `detail` as **plain text** — `capChars(row.detail ?? "",
MAX_TEMPLATE_DETAIL_CHARS)` at `agenda-template-rows.ts:186`, no resolution.

So a naive materialisation either prints a literal `{names:general_evaluator}` on the
agenda, or resolves at adoption time and freezes **a specific member's name** into a
template reused every week — next month's agenda confidently naming someone who is not in
the room.

**Adopted beats keep their tokens**, and `buildTemplateRows` calls the same resolver the
printed row and the deck already share (`roleHolderNames`,
`agenda-runsheet.ts:1568`, described at `:829`). Names stay live: the agenda names whoever holds the role that
week, exactly as today.

The standard path is the norm here, not the exception — that resolver exists precisely so
the deck and the sheet cannot answer "which functionaries?" differently. The template path
is the outlier.

Rejected: resolving role names and stripping person names — it permanently drops the
": Dana" that tells the room who to look at, degrading #585 and making adopted clubs'
agendas worse than unadopted ones.

### D8 — `meeting_template_beats.handoff`

**Also not in the issue.** `meeting_template_beats` has 13 columns and none is `handoff`.
`handoff: true` drives a dedicated slide case (`slide-layout.ts:175`) and four render
branches on the printed sheet (`meeting-agenda-print.tsx:697, 1262, 2062, 2075`).

The contest template has no hand-offs, so this has never mattered. A standard meeting has
4 or 5. Adopting without the column drops all of them: the sheet loses its hand-off
formatting and the projected deck loses its cue slides.

Add `handoff boolean not null default false`, mirroring `flex` exactly. Print and deck
already branch on `r.handoff`, so nothing downstream changes.

TODOS already lists verifying hand-off rows on a real MCF agenda, so they are load-bearing
for this club specifically.

Rejected: inferring hand-off from detail text starting with "Introduces" — a heuristic
over free text an officer can edit, where renaming a row silently costs a slide.

### D9 — Split into 622a and 622b

622a delivers editable ordinary meetings; 622b delivers reuse. Rationale in **What 622a
ships** above.

622a alone answers the original complaint for every meeting rather than templated ones,
and 622b's hardest decision (D4) only bites once reuse exists. Shipping together means a
~1500-line diff across the print path, the deck, two migrations and a new route, on a
repo whose `/ship` review gate is documented not to converge on large diffs.

**Release-note wording for 622a matters.** For the weeks between the two, the honest
description is "you can now fix any Monday", not "your club has an agenda". Saying it the
second way makes a correctly-sequenced release read as half-built.

### D10 — Cap `copyTemplateForMeeting`'s source read, in 622a

Its reads of the SOURCE template are uncapped. Safe today only because every source is a
seeded template whose size the seed fixes. Letting an officer-authored template be a
source makes it an officer-sized read.

The write path already bounds a template at `MAX_TEMPLATE_BEATS` 200,
`MAX_ROLE_REPEAT_SLOTS` 20, `MAX_TEMPLATE_ROLES` 40, `MAX_TEMPLATE_DETAIL_CHARS` 400
(`meeting-template-limits.ts`). The read cap matches those and **refuses** rather than
truncating — a silently truncated agenda is worse than a failed copy.

Per CLAUDE.md's coverage traps, the ceiling must be asserted as an **absolute** number
picked by measuring the cost curve. `expect(x.length).toBeLessThanOrEqual(CAP)` passes for
every value of CAP including one that reintroduces the problem.

---

## Migrations

The issue says there is no migration. There are two.

1. `meeting_template_beats.handoff boolean not null default false` (D8) — 622a.
2. `clubs.default_template_id uuid null references meeting_templates(id) on delete set null` (D6) — 622b.

Generated with `bun run db:generate`, applied with `bun run db:migrate`. Not `db:push` —
see the CLAUDE.md note about partial index predicates, which is also why D6 avoids a
boolean.

---

## Testing requirements

**Day-one parity is the headline test, and it must be a golden output, not a comparison.**
A parity test alone cannot see a defect present on both sides. For each variant, adopting
and rendering must produce the same rows the code path produces today:

- Assert the exact row count (22 / 23 plus 5 band rows).
- Assert the band boundaries against the D2 tables, by index, for both variants.
- Assert the hand-off flags survive: 4 for `geIntro: false`, 5 for `true`.
- Assert token-bearing details still resolve to holder names after a round trip through
  the template path — with a fixture where the holder CHANGES between two renders, so a
  frozen name fails.

**The fixture matrix must span more than one axis.** Per CLAUDE.md, list every unbounded
field before writing the test: speaker count (0, 1, 4), evaluator count, role set
(minimum viable club vs full), GE variant, and club name length. The all-axes-hostile
case is the one no single-variable fixture catches.

**Geometry gates must run.** Adoption changes what prints. `print-page-count.test.tsx` and
`print-density.test.tsx` are the only gates that can see print layout, and they skip
silently on macOS without `CHROME_PATH`.

**Guard tests** for things vitest cannot reach: the disabled-checkbox state (D5) and the
role-add notice (D1) live in routes, which cannot be mounted — comment-blind source
guards via `#/test/guard-source`.

**The `enabled` and picker predicates already have coverage.** Do not duplicate it;
extend it to prove a club-owned row appears for its own club and not for another's.

---

## Rollout

622a is inert until an officer edits an ordinary meeting. No club sees any change on
deploy. The code path stays the seed for new clubs and for any club that has not adopted.

622b's only destructive-adjacent moment is setting a default, and D4 makes that
non-destructive by construction.

---

## Accepted limitations

- **An adopted agenda stops tracking role changes.** Adding a role, flipping the GE
  variant, or renaming a role group will not reshape it. This is D1, taken deliberately;
  the cost is that three settings surfaces have to explain themselves (D1, D5, and the
  role-removal flow).
- **`renderUnowned` becomes dead for adopted clubs.** Subsumed by D1.
- **Between 622a and 622b there is no reuse.** Every edited meeting carries its own copy.
- **The stretchy-row cap stays named for Table Topics.** Separate item, TODOS P3 — the
  agenda editor's "Make stretchy" clamps any row to `TABLE_TOPICS_MAX` (25), which on a
  long agenda cannot absorb the slack. Not in scope here.

---

## Open — resolve during planning, not implementation

- **What "duplicate" produces** on the agendas page (622b): a copy named "X (copy)",
  or a prompt for a name.
- **Whether 622b's agendas page lists global templates** alongside club-owned ones. The
  read already unions them; the page has to decide whether a club can see, and duplicate,
  the seeded Speech Contest.
- **The exact cap number** for D10, which needs the cost curve measured rather than
  chosen.

---

## Reference

The maintainer's reference for the end state is <https://toastmastersvn.com/agenda/>,
step 5 ("Save as Template" / "Your Saved Templates").
