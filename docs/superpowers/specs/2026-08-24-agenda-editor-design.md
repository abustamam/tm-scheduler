# Agenda editor — design

Status: approved in brainstorming 2026-08-24, not yet implemented.
Supersedes nothing. Continues `2026-08-21-configurable-agendas-design.md`
(v1.24.0.0), which shipped per-meeting agenda editing.

Two phases. **Phase 1** makes the existing editor usable for re-timing a
meeting and ships before MCF's club contest on 2026-09-10. **Phase 2** makes a
club's ordinary agenda editable at all, and makes an edited shape reusable.

## Problem

v1.24.0.0 shipped an agenda editor. It can already change every duration on a
templated meeting. It is not used, for four reasons and one omission.

The worked example is MCF's club contest, 2026-09-10, 6:45–8:15 PM
(`meetings.length_minutes = 90`). The seeded `speech_contest` template with the
four contestants who have signed up produces:

| Segment | Rows | Min |
| --- | --- | --- |
| OPENING | Call to order 5 · Welcome 5 · Judges' briefing 10 · Rules and timing 5 | 25 |
| SPEECHES | 4 × (speech 7 + silence 1) = 32 · two-minute silence 2 · interviews 5 | 39 |
| RESULTS AND CLOSING | Tallying 10 · Timers' report 3 · Results and certificates 10 · Closing 5 | 28 |

Total **92 minutes** against a 90-minute slot. Speaking is **28**; everything
else is **64**. The club's complaint — "the non-speaking parts take almost a
whole hour" — is exactly 64 minutes, and the agenda is over its slot before
anyone stands up.

Why the editor does not help:

1. **No clock, no total, no target.** `agenda-editor.tsx` contains no sum and
   no end time. You change `10` to `6` and nothing tells you what that did.
   The over/under sentence *exists* — `flexBannerMessage`
   (`agenda-runsheet.ts:1956`) — but its only caller is
   `club.$clubId_.meeting.$meetingId.print.tsx:167`. It fires on the print
   preview, never where the editing happens.
2. **Card per row, not a table.** Twenty-one tall cards to scroll. Re-timing
   needs the whole shape on one screen; the card stack is itself the obstacle.
3. **Every field blurs to a server round-trip plus a full
   `router.invalidate()`.** Rebalancing ten rows is ten sequential writes and
   ten full route reloads.
4. **The result is thrown away.** Edits land on a private copy
   (`meeting_templates.meeting_id` set). The next contest starts from the same
   92-minute seed.

The omission: **an ordinary meeting cannot be edited at all.**
`loadAgendaDraft` returns `null` when `meetings.template_id IS NULL` and the
route redirects away, so a standard meeting renders the code-derived
`RUN_OF_SHOW` — roughly 25 beats with literal minutes in
`src/lib/agenda-runsheet.ts`. The entire per-club customisation surface today
is one boolean, `clubs.ge_introduces_functionaries`. That is most of the
calendar, and it is the part the club owner objects to being hard-coded.

## What Phase 1 ships

- The editor becomes a table: `Start · Activity · Who · Min`, with the running
  clock on every row.
- A footer stating the honest arithmetic: end time, total, the meeting's slot,
  over/under, and the speaking / everything-else split.
- Instant recomputation — the clock moves as you type, before any save.
- Retiming costs one small write per changed cell and no route reloads.

No schema change. No migration. All eight existing server fns in
`meeting-agenda-edit.ts` keep their signatures.

## What Phase 1 does NOT ship

- Editing a standard (non-templated) meeting. Still redirects. Phase 2.
- Saving a shape for reuse. Phase 2.
- Drag-to-reorder. The existing up/down controls carry over unchanged.
- A "fit to slot" auto-rebalance. Considered and deferred — it has to be
  taught never to touch a speech window, and it needs an undo. The footer
  tells you the number; the officer decides which row loses the minutes.
- Any change to what prints. Phase 1 changes the editing surface only.

## Decisions

### D1 — The editor's clock is not a new derivation

The editor calls the same three pure functions the print route calls, in the
same order (`print.tsx:164-168`):

```
resolveAgendaRows({ geIntroducesFunctionaries, template, slots })
  → applyFlex(rows, meeting.lengthMinutes)
  → buildTimeline(flex.rows, meeting.scheduledAt, timezone)
```

Not a reimplementation of them. This matters more than it looks: CLAUDE.md's
coverage traps record that a parity test cannot see a defect present on both
sides, so an editor clock derived independently would need a cross-surface
test that structurally cannot fail in the one case that matters. Sharing the
derivation removes the second side rather than testing it.

`resolveAgendaRows` (`agenda-runsheet.ts:1985`) is the existing named seam and
already branches on `template: null`, which is what lets Phase 2 reuse this
pipeline for standard meetings with no extra work.

`applyFlex` is in the chain deliberately even though it is a no-op for the
contest (`contest-template.ts` sets `flex: false` on every beat, so
`flexIndices` is empty). Leaving it out would be correct for Phase 1 and wrong
for Phase 2, where a standard meeting's Table Topics row genuinely stretches —
and the editor would then disagree with print about a real meeting.

### D2 — All three functions are pure, so the browser runs them

`agenda-runsheet.ts`, `agenda-template-rows.ts` and `agenda-timing.ts` import
nothing from `#/db`. Verified: their only imports are each other,
`./speech-window`, `./agenda` and `./meeting-template-limits`.

So the client holds `beats`, `roles` and `slots` and recomputes the whole
timeline locally on every keystroke. No round-trip for the clock. This is what
makes the footer feel like a spreadsheet rather than a form, and it is only
available because the derivation was already pure.

### D3 — The table shows the EXPANDED agenda, not the stored beats

The contest stores **15 beats** and prints **21 rows**: `Contest speech` and
`One minute of silence` share a `repeatsRoleKey`, forming a block emitted once
per contestant (`buildTemplateRows`' block loop). A table of the 15 stored
beats would report the speeches costing 8 minutes when they cost 32 — which is
precisely the number the officer opened the editor to find.

So the table renders all 21 rows, matching what prints.

The consequence must be visible rather than discovered: those four speech rows
are **one stored beat**. They render as a bracketed group carrying one set of
controls, and changing the 7 changes all four. That is the correct rule for a
contest — every contestant gets the same window — but a UI that let you type
into row 3 and silently rewrote rows 1, 2 and 4 would be a worse lie than the
one being fixed. The group's edit affordance sits on the group, labelled with
its multiplier ("× 4 contestants"), and the per-row `Start` still reads 7:10 /
7:18 / 7:26 / 7:34 so the clock stays honest.

### D4 — Local draft state; the server API is untouched

The table holds the draft in component state. A cell commits on blur through
the existing `updateAgendaRowFn`.

`router.invalidate()` is dropped for **pure** edits (`label`, `detail`,
`minutes`, `markGreen/Yellow/Red`) — the server's answer for these is the value
just sent, so re-fetching the route to learn it is waste. It is **kept** for
**structural** edits (`addAgendaRow`, `removeAgendaRow`, `moveAgendaRow`,
`roleKey` / `repeatsRoleKey` changes, and every role mutation), where the
server assigns ordering, ids and slot bindings the client cannot predict.

The existing `reseed()`-on-rejection stays exactly as written. Its docblock
already records why: a rejected save produces no re-render, so without it the
field goes on displaying a value that was never saved and looks saved. Dropping
`router.invalidate()` from the success path makes that reasoning *more* load-
bearing, not less, so `reseed()` must not be simplified away in the rewrite.

### D5 — The footer reuses `flexBannerMessage`, and reports honestly

The over/under sentence is `flexBannerMessage(flex)`, already written and
already tested. The editor imports it rather than inventing second copy that
can drift from what the print preview says about the same meeting.

Alongside it the footer states the raw arithmetic: `Ends 8:17 · 92 min · slot
90 min · ▲ 2 OVER`, and the split `Speaking 28 · everything else 64`.

**"Speaking" is defined as rows bound to a role with `isSpeakerRole = true.`**
For the contest that is the four contestants, giving 28. Stated as a decision
because it is arguable: on a standard meeting it counts prepared speeches and
not Table Topics, which is also speaking. Picked because `isSpeakerRole` is an
existing field on both `meeting_template_roles` and `AgendaSlot`, so the number
needs no new data and no per-template configuration. Revisit if the standard
meeting's split reads wrong once Phase 2 exposes it.

The footer does **not** silently absorb an overrun. `applyFlex` runs (D1), so a
standard meeting's stretchy row still stretches and the footer reports the
post-flex truth — but where the agenda cannot be made to fit, it says so
instead of hiding it.

### D6 — `loadAgendaDraft` gains four fields, additively

`AgendaDraft` today carries `templateId`, `templateName`, `editable`, `rows`,
`roles`. The client pipeline in D1 also needs:

- `slots: AgendaSlot[]` — the meeting's `role_slots`, which is what
  `buildTemplateRows` fans the repeat block across and where the holder names
  in the `Who` column come from.
- `scheduledAt`, `timeZone` — for `buildTimeline`.
- `lengthMinutes` — the slot to measure against.
- `geIntroducesFunctionaries` — unused on the template branch, required by
  `resolveAgendaRows`' signature and load-bearing for Phase 2.

All additive; no existing consumer changes. `loadAgendaDraft` is already in
`meeting-agenda-edit-logic.ts`, i.e. on the `-logic` side of the split, so the
new query is reachable from an integration test — which is the reason that
split exists (`club-logic.ts`'s second motive in CLAUDE.md).

### D7 — Numbers live in `lib/`, not in the component

A new pure module `src/lib/agenda-budget.ts` takes the timed rows plus the slot
length and returns totals, end time, delta, status and the speaking split.

Not in the component and not in a server-fn module, for the reason CLAUDE.md
records twice: a constant defined in a module that imports `#/db` cannot be
imported by a unit test (`DATABASE_URL is not set`), and a schema private to a
server-fn module is invisible to vitest — so the whole layer can be deleted or
have its bounds raised with the suite green. #522 shipped its render caps into
the wrong module *inside the change that cited this trap*.

## Testing requirements

Against the coverage traps in CLAUDE.md, which several of these exist to dodge.

- **`agenda-budget.test.ts` asserts ABSOLUTE values, not relative ones.** The
  real contest fixture — four contestants, 6:45 PM start, 90-minute slot —
  must assert `total === 92`, `endsAt === "8:17"`, `delta === 2`,
  `status === "over"`, `speaking === 28`. Not
  `expect(total).toBe(sumOf(rows))`, which passes for every possible bug. This
  is the #519 trap stated as a test.
- **A row-by-row clock assertion**, pinning the literal strings `6:45`, `6:55`,
  `7:10`, `7:18`, `7:26`, `7:34`, `7:49`, `8:12`. The per-row `Start` is the
  feature; a total that is right while row 9 is wrong is still a broken editor.
- **A repeat-block case.** The fixture must run at 4 contestants *and* at 1 and
  at 0. The one-contestant case is where `numbered()` stops numbering and the
  block collapses; the zero case is where the block emits nothing and the
  speeches segment vanishes. A single-arity fixture is the #522 trap.
- **An editor/print parity test on the same fixture.** Cheap because both sides
  call the same functions (D1), and its job is to fail loudly if a later change
  forks the derivation. Explicitly NOT the only guard on the clock — per the
  parity trap, it sits *alongside* the absolute golden assertions above, never
  instead of them.
- **Group-edit behaviour in `agenda-editor.test.tsx`:** editing the speech
  group's minutes issues exactly ONE `onUpdateRow` naming the shared beat, not
  four. Assert the call, not the resulting display.
- **Footer state transitions:** under → exact → over as minutes change, and
  that the sentence shown is `flexBannerMessage`'s, not a second copy.
- **`agenda-editor-wiring.guard.test.ts` gains the new prop expressions.** The
  route computes `slotMinutes`, `scheduledAt` and the slot array and passes
  them in; a prop-fed component test cannot see a WRONG prop (#319 —
  `isMember={shell}`). Extend the existing guard file rather than adding one,
  and read comment-blind via `#/test/guard-source`.
- **Integration coverage for the four new `loadAgendaDraft` fields**, in
  `meeting-agenda-edit-logic.integration.test.ts`. Needs
  `TEST_DATABASE_URL` or it silently skips.

## Rollout

Phase 1 is one PR. It touches:

| File | Change |
| --- | --- |
| `src/lib/agenda-budget.ts` | New. Pure. Totals, end time, delta, status, speaking split. |
| `src/components/agenda/agenda-editor.tsx` | Card stack → table. Stays presentational (every mutation is a prop), so it stays reachable from vitest without the Start runtime. |
| `src/server/meeting-agenda-edit-logic.ts` | `loadAgendaDraft` returns the four added fields (D6). |
| `src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx` | Wires the new props. |
| `src/routes/agenda-editor-wiring.guard.test.ts` | Extended for the new prop expressions. |

Ship to production before 2026-09-10 and re-time the contest agenda on the
live site, not on a fixture. The contest is the acceptance test.

## Phase 2 — club-owned agendas

Sketched here; to be specified in full before implementation.

- **Save as club template.** Copy the meeting's private row
  (`meeting_id` set) into a new row with `meeting_id NULL` and `club_id` set.
  `meeting_templates` already models the distinction and the reads already
  admit club-scoped rows, so this needs no migration — TODOS.md already states
  this under "Next increment: save this shape as a template".
- **Adopt your own standard agenda.** Materialise `RUN_OF_SHOW` — expanded with
  the club's current role set and its `ge_introduces_functionaries` variant —
  into an editable club template. The code path stays as the seed for new
  clubs and for any club that has not adopted.
- **A club default**, so meetings generated by a recurrence rule inherit the
  adopted agenda rather than the code path.
- **`/club/$clubId/agendas`** — list, edit, duplicate, set default, disable.

Two decisions already taken in brainstorming:

- **Beat gating does not come back.** Once a club adopts, a row stays until it
  is deleted. Adoption bakes in the roles the club runs that day, so day one is
  identical to today. Afterwards, removing a club role offers to delete its
  agenda rows and names them first — the same pattern as v1.24.0.0's "removing
  a role tells you who loses it". Rejected: a per-row "hide when unstaffed"
  flag (one more concept, and a row can still vanish for a reason not on
  screen) and auto-hiding an unheld row (reintroduces the invisible authoring
  `agenda-template-rows.ts`' own docblock argues against).
  This is distinct from "nobody signed up this week", which v1.24.0.0 already
  settled: the row prints with an empty holder.
- **No new tables.** Rejected a separate club-agenda table (duplicates a
  distinction `meeting_templates` already models) and a per-club minutes-
  override JSON (cheapest, but yields no reordering and no new rows — a dead
  end for a templater).

Phase 2 must carry one thing TODOS.md already flags:
`copyTemplateForMeeting`'s reads of the SOURCE template are uncapped, and are
safe today only because every source is a seeded template whose size the seed
fixes. Letting an officer-authored template be a source makes that an
officer-sized read. Cap it at the seam, in that change.

## Reference

The club owner's reference for the templater is
<https://toastmastersvn.com/agenda/>, whose step 4 is the table this design
adopts (`Start · Activity · Duration · Person · Notes`, click-to-edit cells,
Add Row / Add Header) and whose step 5 is Phase 2's "Save as Template" /
"Your Saved Templates".

Two things it does that this design deliberately does not copy. Its `Person`
column is free text; GavelUp's comes from real `role_slots`, so the agenda and
the sign-up sheet cannot disagree. And its templates export to a file for
sharing between clubs — out of scope, and worth re-reading only once club
templates exist to share.

## Accepted limitations

- **The print squeeze cliff is not addressed and gets easier to reach.**
  `FitPage` scales a sheet until it fits unless the scale would drop below
  `MIN_FIT_SCALE`, at which point the sheet flows at full size — so legibility
  is not monotonic in length, and a 21-row agenda can print smaller than a
  40-row one. Already open in TODOS.md at P3, already noted there as easier to
  hit now that officers author agendas. A faster re-timing surface makes row
  counts move more often. Not made worse by this change; not fixed by it.
- **The editor is still officer-only and still a separate page.** Unchanged
  from v1.24.0.0.
- **No undo.** Each cell save is committed. The mitigation is that the clock
  now shows the consequence before the blur, which is most of what undo was
  for here.
