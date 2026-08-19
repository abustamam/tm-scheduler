# Agenda templates — design

Date: 2026-08-19
Status: Approved for implementation planning
Phase: 1 of 2 (Phase 2 — club-authored templates + editor UI — is a separate spec)

## Problem

A club's meeting has exactly one shape. `role_definitions` supplies the roles, and
`RUN_OF_SHOW` (`src/lib/agenda-runsheet.ts`) supplies the run-of-show, with exactly one
per-club axis of variance (`clubs.ge_introduces_functionaries`). A club that runs a speech
contest, a business meeting or an open house has to shoehorn it into the standard agenda:
the roles it needs (Contest Chair, Chief Judge, Ballot Counter, Contestant) cannot be
expressed, and the printed sheet and projected deck describe a meeting that is not happening.

This spec adds **meeting templates**: a named bundle of a role set plus a run-of-show that a
meeting can be built from or converted to.

## What Phase 1 ships

- Three new tables and two new columns (below).
- One seeded **global** template: **Speech Contest**.
- A per-meeting template picker for club `admin`/`vpe`, including converting a meeting that
  already exists and may already have claims on it, behind a preview.
- Templated meetings print (run sheet, both layouts) and project (a generic beat-driven deck),
  and their roles are claimable, assignable, confirmable and reminder-eligible exactly as
  standard roles are.
- Contestant slots are speaker-category roles, so speeches, the project picker and Pathways
  attribution work unchanged.

## What Phase 1 does NOT ship

- No template editor UI, and no club-authored templates. Templates are stored as data from day
  one specifically so Phase 2 needs no migration, but Phase 1 writes them only via the seed.
- No second seeded template. The machinery ships with one non-standard shape; adding a
  second is then a data change, not a code change.
- No slot preservation across a template switch (see **Accepted limitations**).

## Decisions

### D1 — Templates are additive; the standard meeting stays code-derived

`meetings.template_id` is nullable and **NULL means the current code path, unchanged**. A
templated meeting's run-of-show comes from stored rows; a NULL-template meeting's comes from
`buildRunOfShow()` exactly as today.

Stored beats are **flat**: an ordered list with a label, minutes, an optional bound role, and
optional timer marks. They carry none of `requiresAnyOf`, `requiresGroup`,
`alsoRequiresGroup`, `alsoRequiresAnyOf`, `fallbacks[]`, `renderUnowned` as a per-beat choice,
or the `{roles}` / `{names:key}` / `{awards}` tokens.

That omission is the design, not a shortcut. The standard run-of-show needs those gates
because it must adapt to whatever roles a club actually runs — a skeleton crew with no
Ah-Counter, a renamed General Evaluator, a club with no Table Topics Master. **A contest agenda
does not adapt; its shape is fixed by the contest rules.** Two different problems, so two
different mechanisms.

Rejected alternative: migrate `RUN_OF_SHOW` into the data model so there is one engine. That
requires making eight conditional concepts relational and editable, inside the most heavily
tested part of the app, and `agenda-parity.test.ts` could not prove the migration faithful —
a parity test cannot see a defect present on both sides (CLAUDE.md, coverage traps). Large
rewrite, no requested benefit.

Rejected alternative: store agenda rows on the meeting, seeded from a template and then freely
editable (the reference site's model, <https://toastmastersvn.com/agenda/>). It forks the
agenda from `role_slots`, so a hand-typed row is not claimable and print, deck, minutes and
voting stop seeing the same agenda. Viable later as a per-meeting override layered on top of
this design; not a foundation.

### D2 — A template's roles are materialized into `role_definitions`

`role_slots.role_definition_id` is `NOT NULL` and `ON DELETE RESTRICT`, so a claimable contest
role must be a real `role_definitions` row. On first use of a template at a club, its roles are
copied into `role_definitions` with `template_id` set, idempotently keyed by
`(club_id, template_id, key)`.

Consequences, all desirable: the club can rename them (`updateClubRole`), every surface labels
with the club's own name per #445, and role history over `role_slots` includes contest service
for free.

### D3 — `role_definitions`' unique index splits in two

Today: `role_definitions_club_key_unique` on `(club_id, key) WHERE key IS NOT NULL`. It
enforces "at most one role per club per standard key".

A contest template containing a `timer` role would collide with the club's standard `timer`.
Widening the index to `(club_id, template_id, key)` **silently destroys the existing
guarantee**, because Postgres treats NULLs as distinct: standard roles carry
`template_id IS NULL`, so every standard row would become unconstrained and a club could hold
two standard Timers with nothing failing.

So the one index becomes two partial ones:

- `(club_id, key) WHERE key IS NOT NULL AND template_id IS NULL` — today's guarantee, preserved
  verbatim.
- `(club_id, template_id, key) WHERE key IS NOT NULL AND template_id IS NOT NULL` — the same
  guarantee per template.

Rejected alternative: namespace template role keys (`speech_contest.timer`) so nothing
collides and the index is untouched. Rejected because it splits one role's identity in two —
"who has served as Timer" would have to know both spellings — and #368 exists precisely to give
a role one rename-proof identity.

### D4 — `repeats_role_key` makes a repeating block adapt to signups

A contest runs `[Contestant N] [Minute of silence]` once per contestant. Stored as literal
rows, the contestant count is fixed when the template is authored (the reference site fixes it
at six). A four-contestant contest then prints two `— open —` contestant rows, books six
minutes of silence that will not happen, and shows a wrong finish time; a seventh contestant
has no row at all.

`meeting_template_beats.repeats_role_key` instead marks a beat as repeating once per slot of
that role. **Consecutive beats sharing the same non-null `repeats_role_key` form one block**,
emitted once per slot, with the role-bound beat inside it numbered. Two stored rows print eight
rows for four contestants and fourteen for seven, with the clock correct either way.

This is the behaviour `expandRunSheet` + `numbered()` already give Speakers on the standard
sheet, made available to templates and extended so a *pair* of rows repeats together rather
than a single row.

### D5 — Conversion is admin/vpe only, behind a preview

Applying or changing a meeting's template reshapes the meeting. That sits with reschedule and
cancel, not with the agenda-content edits ADR-0010 grants the self-asserted Toastmaster. It is
blocked on `held` / `cancelled` meetings by the lifecycle lock (ADR-0012) and on archived clubs.

### D6 — Present mode gets one generic beat-driven deck, not a bespoke contest deck

`buildSlideDeck` is hand-written against the seven standard role keys (the `ROLE` map,
`agenda-slides.ts:283`); it shares the beats' durations but composes slides imperatively. A
templated meeting gets a generic deck instead: reused title slide, one slide per section, one
slide per beat, reused thank-you slide. Every future template gets projection for free.

Word-of-the-Day, the three vote slides and the awards slide stay standard-only. A contest is
judged on paper ballots by judges rather than by a room vote, so omitting them is correct
rather than a gap.

### D7 — Seed contest labels are generic, not TI marks

"International Speech Contest", "Table Topics Contest" and "Evaluation Contest" are Toastmasters
International marks. ADR-0024 sets a trademark-safe default and #384 tracks pre-commercialization
brand hygiene. The seed uses **Prepared Speech Contest**, **Impromptu Speaking Contest** and
**Speech Evaluation Contest** as segment labels. Because template roles and labels are materialized per
club and renameable, a club that wants official wording sets it locally.

## Data model

### New: `meeting_templates`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `club_id` | uuid null → `clubs.id` on delete cascade | **NULL = global** |
| `key` | text not null | stable identity, e.g. `speech_contest` |
| `name` | text not null | |
| `description` | text | shown on the picker card |
| `default_length_minutes` | integer null | overrides `clubs.default_meeting_minutes` on apply |
| `sort_order` | integer not null default 0 | |
| `enabled` | boolean not null default true | disable, never delete — see below |
| `created_at` | timestamp not null default now | |

Indexes: `unique (key) WHERE club_id IS NULL`, `unique (club_id, key) WHERE club_id IS NOT NULL`.
Two partial indexes rather than one, for the same NULL-distinctness reason as D3. The idiom
already appears at `role_definitions_club_key_unique` and `meetings_club_number_unique`.

Templates are **disabled, not deleted**, mirroring `role_definitions.enabled`: a past meeting
references its template, and `meetings.template_id` is `ON DELETE RESTRICT`.

### New: `meeting_template_roles`

`id`, `template_id` (→ `meeting_templates.id` on delete cascade), `key`, `name`, `category`
(`role_category` enum), `default_count`, `sort_order`, `is_speaker_role`, `description`.
Unique `(template_id, key)`.

Deliberately the same shape as `RoleSeed` (`src/lib/role-template.ts`) so materialization into
`role_definitions` is a field-for-field copy.

### New: `meeting_template_beats`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `template_id` | uuid not null → cascade | |
| `sort_order` | integer not null | |
| `kind` | enum `section` \| `role` \| `event` | |
| `label` | text not null | the activity, or the section title |
| `detail` | text | the notes column |
| `minutes` | integer not null default 0 | contributes to the running clock |
| `role_key` | text null | binds to `meeting_template_roles.key`; who presents |
| `repeats_role_key` | text null | see D4 |
| `flex` | boolean not null default false | at most one per template, validated on write (not DB-enforced) |
| `mark_green` / `mark_yellow` / `mark_red` | numeric null | timer-card marks |

Unique `(template_id, sort_order)`.

### Not a table: template → club role mapping

Materialization writes into `role_definitions` directly (D2), keyed by
`(club_id, template_id, key)`. There is no join table.

### Changed: `meetings`

`template_id uuid null references meeting_templates(id) on delete restrict`. NULL is today's
behaviour, unchanged.

### Changed: `role_definitions`

`template_id uuid null references meeting_templates(id) on delete restrict`. NULL = the club's
own standard roles. `/admin/roles` and `listClubRoles` filter `template_id IS NULL`, so template
roles never appear in the club's role editor and are never picked up by standard slot
generation.

## Behaviour

### Slot generation

`generateSlotRows` (`src/lib/agenda.ts`) is **unchanged**. The caller chooses the definitions:

- `resolveMeetingRoleDefs(conn, clubId, templateId)` in a new `meeting-templates-logic.ts`
  returns `template_id IS NULL AND enabled` definitions when `templateId` is null, and the
  template's definitions otherwise — materializing them first if this club has not used the
  template before.
- `insertMeetingWithSlots` (`meeting-create-logic.ts`) takes the resolved defs as it already
  does. The recurrence top-up and batch creator pass `templateId: null` and behave identically
  to today.

`linkEvaluatorsToSpeakers` already no-ops when `pickSpeakerAndEvaluatorRoles` cannot identify a
speaker/evaluator pair, which is the contest case. No change needed.

### Conversion

`previewMeetingTemplate({ meetingId, templateId })` — read-only, returns three counts: open
slots to be removed, claimed/confirmed slots to be released, and slots carrying a speech.

`applyMeetingTemplate({ meetingId, templateId })` — one transaction:

1. Authorize `admin`/`vpe` via `requireMembership`; assert club not archived; assert meeting
   status is `scheduled`.
2. Materialize the template's role definitions for this club if absent (idempotent).
3. Release every slot not belonging to the new definition set (clear assignee, clear
   `speech_id`, set `open`), then delete those slots.
4. Insert slots for the new definition set via `generateSlotRows`.
5. Set `meetings.template_id`, and `meetings.length_minutes` from
   `default_length_minutes` when the template supplies one.
6. Enqueue a notification to each released holder; write `activity_log`.

Speeches are Person-owned (ADR-0009) and survive; only the slot pointer clears.

Setting `templateId: null` converts back to a standard meeting by the same path.

### Rendering the run sheet

New `resolveRunOfShow({ templateBeats, geIntroducesFunctionaries })` returns
`buildRunOfShow({ geIntroducesFunctionaries })` when `templateBeats` is null and the adapted
beats otherwise. It replaces the duplicated `buildRunOfShow(...)` calls at
`src/routes/club.$clubId.meeting.$meetingId.tsx:375` and
`src/routes/club.$clubId_.meeting.$meetingId.print.tsx:156`, which are copy-pasted today and
are the seam where screen and print could silently diverge.

New `src/lib/agenda-template-beats.ts` adapts stored rows to `Beat[]`:

- Expand `repeats_role_key` blocks first, once per slot of the bound role (D4).
- `kind: "role"` → `{ kind: "role", roleKey, roleName, role: isSpeakerRole ? "speaker" : "plain",
  detail, minutes, marks, renderUnowned: true }` with no gates. `renderUnowned` is on for every
  template role: a contest prints its rows whether filled or not.
- `kind: "event"` → `{ kind: "event", who: label, detail, minutes }`.
- `kind: "section"` → a band row carrying no clock stamp, following the existing `handoff` /
  `HandoffBand` precedent in `agenda-groups.ts` and the print layouts.

Everything downstream is untouched: `expandRunSheet`, `buildTimeline`, `groupByPresenter`, both
print layouts, `applyFlex`. A template may mark one flex beat or none; with none, `applyFlex`
no-ops and the over/under banner does not render.

### Rendering the deck

`buildSlideDeck` branches on the meeting's template (D6) and builds title → per-section →
per-beat → thank-you. One new `Slide` kind, therefore one new case in `deck-to-pptx.ts` and one
in `meeting-present.tsx`.

## Module layout

Per the server-module rule (`server-modules.guard.test.ts`):

- `src/server/meeting-templates.ts` — `createServerFn`s and types only:
  `listMeetingTemplates`, `previewMeetingTemplate`, `applyMeetingTemplate`.
- `src/server/meeting-templates-logic.ts` — all db logic: `resolveMeetingRoleDefs`,
  `materializeTemplateRoles`, `loadTemplateBeats`, `planTemplateConversion`.
- `src/lib/agenda-template-beats.ts` — the pure stored-rows → `Beat[]` adapter.
- `src/lib/meeting-template-limits.ts` — the caps (below), in `lib/` so they are assertable.

`listMeetingTemplates` reads no club data and is officer-gated; if any reader ends up
session-less it must go through a gated seam named `Public*` or be waived in `REVIEWED_UNGATED`
with a reason, per `public-readers-archive-gate.guard.test.ts`.

## Test plan

Assessed against the diff. The repo-specific traps that apply here:

- **Print page count, across a fixture matrix.** A contest agenda is multi-page, so the
  one-sheet promise does not hold and must not be asserted. `print-page-count.test.tsx` gets a
  contest fixture at **4, 6 and 7 contestants** plus a long club name and long custom role
  names. `repeats_role_key` is exactly the code that breaks across contestant counts, and a
  single-variable fixture is what let the role sheets' page count be wrong four times in a row.
  Needs `CHROME_PATH` on macOS (Playwright `chrome-headless-shell`, not Chrome.app).
- **Parity plus golden output.** `agenda-parity.test.ts` proves run sheet and deck agree but
  cannot see a defect present on both sides. Each seeded template also gets golden assertions:
  a contest sheet must contain a Chief Judge row, a Contestant row and a Results section.
- **Absolute ceilings in `lib/`.** Caps on beats-per-template and roles-per-template are stated
  as absolute numbers picked by measuring render cost, not relative to the constant, and live in
  `src/lib/meeting-template-limits.ts` so a unit test can reach them without `DATABASE_URL`.
- **Conversion integration tests** (`TEST_DATABASE_URL` required): claimed slot released and its
  holder notified; attached speech survives with the slot pointer cleared; `held` meeting
  rejected; archived club rejected; TMOD rejected while admin/vpe succeeds; applying the same
  template twice materializes roles once.
- **Index regression test.** A club may not hold two standard `timer` role definitions (D3's
  preserved guarantee) and may hold one standard `timer` alongside one contest `timer`.
- **Guard coverage.** `server-modules.guard.test.ts` and
  `public-readers-archive-gate.guard.test.ts` enrol the new modules automatically.

## Accepted limitations

- **Converting standard → contest → standard loses assignments both ways.** Each template owns
  its role definitions, so there is no overlap to preserve and slots are rebuilt in both
  directions. The preview makes it visible before it happens. Slot preservation across templates
  is deferred.
- **A contest Timer is a separate role definition from the club's standard Timer.** They share
  the key `timer` and differ by `template_id`, so role history reads correctly, but the two rows
  are renamed independently.
- **Templated meetings project a plainer deck than standard meetings.** Accepted in exchange for
  every future template getting projection with no new code.

## Open questions for implementation

None blocking. Contest role counts in the seed (judges, ballot counters, timers) should be
checked against the current Toastmasters contest rulebook during implementation; the counts are
data and changing them later is a seed edit, not a migration.
