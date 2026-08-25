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

- **First edit materialises a private per-meeting template** from
  `buildRunOfShow({ geIntroducesFunctionaries })` — NOT the `RUN_OF_SHOW` const, which is
  built with the variant hardcoded `false` (`agenda-runsheet.ts:1333`) — expanded with the
  club's current role set (D3, R5).
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

Opening an ordinary meeting's agenda and editing it materialises
`buildRunOfShow({ geIntroducesFunctionaries })` — read from the club, never the
`RUN_OF_SHOW` const — into a **private per-meeting template**, exactly as editing a
templated meeting already does. See R5.

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

## Review outcomes (plan-eng-review, 2026-08-25)

Nine findings, all resolved with the maintainer. R-numbers are referenced from the
decisions above where they change them.

### R1 — Adoption unsubscribes a club from agenda improvements. ACCEPTED, with a notice.

Materialisation is copy-once. `agenda-runsheet.ts` took 27 commits in six months and **15
changed beat content** — roughly one every 12 days, including "close on announcements →
guest comments → adjourn" and "the deck and the run sheet book the same minutes". None of
those would reach an adopted club.

Accepted deliberately, because a thing that silently rewrites an adopted agenda is the
invisible authoring D1 rejects. **The adopt action must say so**: "from now on this agenda
is yours — improvements we ship to the standard agenda will not reach it." The recovery
path stays TODOS:101, re-scoped to P2 as part of this review.

### R2 — The recurrence pruner's stated reason goes stale. FIX THE COMMENT.

`recurrence-rule-logic.ts:127–133` excludes meetings with a template, justified in-comment
as "somebody deliberately reshaped it into a contest". After D3 that clause catches any
meeting whose agenda was edited at all.

Behaviour stays: an edited agenda IS content, and the predicate already blocks pruning on
any content (`!m.theme`, `!m.wordOfTheDay`, a claimed slot). The **comment must be
corrected in 622a** — it will otherwise assert something false on the exact clause a
future reader would trust. Same shape as `someRowStretches`, which carried "only ever
changed by a button that round-trips" after that had stopped being true.

### R3 — 622b's writes need a gate that does not exist. SPEC IT.

Every agenda write today goes through `requireMeetingTemplateEditor`
(`meeting-templates-logic.ts:73`): `requireUser` → `assertClubNotArchived` →
`requireClubRole(["admin"])`. It is keyed on a **meetingId**.

622a is covered by it. 622b's writes are not: save-as-club-template is template-keyed,
set-default and `/agendas` are club-keyed.

**622b adds `requireClubTemplateEditor`**, mirroring the existing helper, and for
template-keyed calls it resolves the template's `club_id` server-side and asserts it
matches — **in the query, not a caller-side filter**. Without it, a raw template id from
the client is a cross-club write. The docblock at `meeting-templates-logic.ts:90` already
warns about exactly this, citing #544 and #560.

Safety net worth knowing: `public-readers-archive-gate.guard.test.ts` derives its
candidates by walking `src/server` for `createServerFn` with no `require*` guard, so a
forgotten gate is caught — but only the archive half, never the tenant half.

### R4 — Cap calibration must follow the token work. ORDERING FIXED.

D10 picks the cap's ceiling by measuring the cost curve; D7 changes what a row costs
(`roleHolderNames` → `introducedNames` scans the slot array, once per token-bearing row).
**Measure after D7 lands**, with a fixture carrying a token in every row's detail and a
full slot set. A realistic adopted agenda is 28 rows and will not notice; the cap exists
for the case that is not realistic.

### R5 — The spec named the wrong symbol. CORRECTED ABOVE.

`RUN_OF_SHOW` is `buildRunOfShow({ geIntroducesFunctionaries: false })`
(`agenda-runsheet.ts:1333`). The spec said "materialise `RUN_OF_SHOW`" in two places.
Followed literally, every club adopts the 22-beat variant and **MCF silently loses
`geOpeningHandoff`**, with the functionary intro moving from the General Evaluator back to
the Toastmaster — on day one, in the release whose promise is that day one is identical.

Corrected in both places, and pinned: a test must assert the MCF variant materialises **23
beats including `geOpeningHandoff`**, not merely that materialisation works.

### R6 — The materialiser's seam and assertion style. BOTH SPECCED.

The band tables are called the acceptance criteria, but nothing said where the code lives
or how to assert it. Both decide whether that test can exist and can fail.

- **Placement:** a pure function in `src/lib/` — `(beats, roles, variant) →
  TemplateBeatSeed[]` — with no `#/db` import. A `createServerFn` handler body is
  unreachable from vitest, and a module importing `#/db` throws `DATABASE_URL is not set`
  in a unit test. `src/lib` is currently db-free; keep it that way.
- **Assertions:** the boundary test **hardcodes** `0–3 / 4–6 / 7–9 / 10–17 / 18–21` as
  literals. It must not import whatever constants the materialiser uses — an assertion
  stated relative to the constant it guards passes for every value of it (#519).

### R7 — D4 had no test requirement. ADDED.

D4 is the rule that a private fork survives a newly-set club default plus the list naming
which meetings kept theirs. It received the most attention in grilling and the testing
section never mentioned it.

**622b requires an integration test covering both halves**: seed a club with two future
meetings, one forked and one not; set a default; assert the forked one still points at its
fork, the unforked one takes the default, and the returned list names exactly the forked
one. The naming half is not optional — a test asserting only survival passes with the
notice unimplemented, and then the officer sets a default, sees nothing change, and
concludes the feature is broken. That is the failure D4 exists to prevent.

### Failure modes

| New codepath | Realistic production failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| Materialise on first edit | Wrong GE variant baked in | Yes, after R5 | n/a | **Would have been silent** |
| Materialise on first edit | Partial write leaves a template with no beats | Add: wrap in a transaction | Throws | No |
| Token resolution in template path | Unknown role key leaves `{names:x}` verbatim | Yes (round-trip test) | Returns null, token left as-is | Visible on the sheet |
| Save as club template (622b) | Template id from another club | Yes, after R3 | Throws | No |
| Set default (622b) | Forked meetings silently re-pointed | Yes, after R7 | n/a | **Would have been silent** |
| Cap refusal | Source template over the ceiling | Add per D10 | Refuses, does not truncate | No |

Two entries were silent-and-untested before this review. Both are now covered.

### Diagrams the implementation should carry

- **`src/lib/<materialiser>.ts`** — the adoption pipeline, because it is a multi-step
  transform whose stages are easy to reorder wrongly:

```
buildRunOfShow({ geIntroducesFunctionaries })   club's variant, NOT the const
        |  22 or 23 beats, gating still attached
        v
  resolve gating against the club's CURRENT slots   <- D1: evaluated ONCE, here
        |  gated-out beats dropped for good
        v
  assign five section bands (D2 tables)
        |  + 5 section rows
        v
  map Beat -> TemplateBeatSeed
        |  detail tokens preserved VERBATIM (D7), handoff carried (D8)
        v
  INSERT meeting_template_beats   (one transaction)
```

- **`src/server/recurrence-rule-logic.ts:127`** — the corrected comment (R2) should say
  what `templateId != null` means AFTER 622a, not what it meant when only contests set it.

### Worktree parallelization

Sequential implementation, no parallelization opportunity. 622a's steps form one chain:
the handoff column and the token vocabulary both gate the materialiser, which gates the
parity tests. 622b depends on 622a end to end.

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

**The MCF variant is a required case, not an optional one** (R5). Assert 23 beats
including `geOpeningHandoff` for `geIntroducesFunctionaries: true`, and 22 without.

**Band boundaries are asserted as literals** (R6), never imported from the materialiser.

**622b: the fork-vs-default rule needs an integration test** covering survival AND the
naming (R7), and the tenant boundary needs one proving a template id from another club is
refused (R3).

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

---

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — materialiser — call `buildRunOfShow({ geIntroducesFunctionaries })`, never the `RUN_OF_SHOW` const
  - Surfaced by: Code Quality — R5, `agenda-runsheet.ts:1333` hardcodes the variant `false`
  - Files: the new `src/lib/` materialiser; spec lines already corrected
  - Verify: test asserting the MCF variant yields 23 beats including `geOpeningHandoff`, and 22 without
- [ ] **T2 (P2, human: ~1h / CC: ~10min)** — materialiser — pure function in `src/lib/`, no `#/db` import
  - Surfaced by: Code Quality — R6, a handler body is unreachable from vitest
  - Files: `src/lib/<materialiser>.ts`
  - Verify: the band-boundary test imports it directly and runs without a database
- [ ] **T3 (P2, human: ~30min / CC: ~5min)** — materialiser tests — hardcode the band boundaries
  - Surfaced by: Code Quality — R6, #519's relative-assertion trap
  - Files: the materialiser's test
  - Verify: literals `0–3 / 4–6 / 7–9 / 10–17 / 18–21`, no import of the boundary constants
- [ ] **T4 (P2, human: ~30min / CC: ~5min)** — recurrence — correct the pristine predicate's comment
  - Surfaced by: Architecture — R2, `recurrence-rule-logic.ts:127–133` says "reshaped it into a contest"
  - Files: `src/server/recurrence-rule-logic.ts`
  - Verify: comment states what `templateId != null` means after 622a; behaviour unchanged
- [ ] **T5 (P2, human: ~2h / CC: ~10min)** — adoption UI — the adopt action states the one-way trade
  - Surfaced by: Architecture — R1, 15 of 27 commits changed beat content
  - Files: the adopt/first-edit surface
  - Verify: comment-blind source guard, since the copy lives in a route
- [ ] **T6 (P2, human: ~4h / CC: ~20min)** — 622b — `requireClubTemplateEditor` with a server-side tenant check
  - Surfaced by: Architecture — R3, `meeting-templates-logic.ts:73` is meeting-keyed
  - Files: `src/server/meeting-templates-logic.ts` and 622b's server fns
  - Verify: integration test proving a template id from another club is refused
- [ ] **T7 (P2, human: ~3h / CC: ~15min)** — 622b — integration test for D4, both halves
  - Surfaced by: Tests — R7, the testing section covered D1/D2/D5 only
  - Files: a 622b integration test
  - Verify: fork survives, unforked takes the default, returned list names exactly the forked meeting
- [ ] **T8 (P3, human: ~2h / CC: folded into D10)** — cap — measure after D7, with tokens on every row
  - Surfaced by: Performance — R4, D7 changes per-row cost
  - Files: the cap's calibration fixture
  - Verify: measured ceiling is an absolute number, fixture carries a token per row and a full slot set

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | NOT RUN | codex not installed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 7 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE VOICE: NOT RUN.** `codex` is not installed (no OpenAI subscription on this
  machine) and `CLAUDE.md` forbids the Agent tool, so the Claude-subagent fallback could
  not be dispatched either. This review is one model, and that model wrote the spec it
  reviewed. Weigh it accordingly: learning `assert-final-rows-not-intermediate-beats`
  (10/10, cross-model) records an agenda-template plan that passed a full eng review AND a
  design review carrying a broken core mechanism, where a fresh-context outside voice
  caught it and two reviews by the plan author did not. Mitigation applied here: every
  finding was derived by re-running or re-reading the SOURCE rather than re-reading the
  spec's prose, which is how R5 was caught. Note also that `codex_reviews` reads `enabled`
  while CLAUDE.md states it is `disabled` — that mismatch is worth fixing.
- **VERDICT: ENG CLEARED — ready for `writing-plans`.** 7 findings, all resolved with the
  maintainer; 2 previously-silent failure modes now covered by required tests.

NO UNRESOLVED DECISIONS
