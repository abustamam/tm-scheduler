# Agenda editor — design

Status: approved in brainstorming 2026-08-24, revised the same day after a
grilling pass, not yet implemented.
Supersedes nothing. Continues `2026-08-21-configurable-agendas-design.md`
(v1.24.0.0), which shipped per-meeting agenda editing.

Two phases. **Phase 1** makes the existing editor usable for re-timing a
meeting. **Phase 2** makes a club's ordinary agenda editable at all, and makes
an edited shape reusable. Neither is coupled to a date — see Rollout.

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
- Per-section subtotals on each section band, so the time is located rather
  than merely counted.
- A footer stating the arithmetic unconditionally: end time, total, the
  meeting's slot, and the signed delta.
- Instant recomputation — the clock moves as you type, before any save.
- Retiming costs one small write per changed cell and no route reloads.
- Undo on row deletion.

No schema change. No migration. The eight existing server fns in
`meeting-agenda-edit.ts` keep their signatures; one gains an optional patch
field (D7).

## What Phase 1 does NOT ship

- Editing a standard (non-templated) meeting. Still redirects. Phase 2.
- Saving a shape for reuse. Phase 2.
- Drag-to-reorder. The existing up/down controls carry over unchanged.
- A "fit to slot" auto-rebalance. Considered and deferred — it has to be
  taught never to touch a speech window, and it needs an undo of its own. The
  footer states the number; the officer decides which row loses the minutes.
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
contest (`contest-template.ts` sets `flex: false` on every beat, and no beat
overrides it, so `flexIndices` is empty). Leaving it out would be correct for
Phase 1 and wrong for Phase 2, where a standard meeting's Table Topics row
genuinely stretches — and the editor would then disagree with print about a
real meeting.

**This imposes a hard requirement on the payload, and it is easy to miss.**
`buildTemplateRows` reads `row.flex` to mark the row that `applyFlex` then
resizes. `AgendaDraftRow` does **not** carry `flex` today. Ship the pipeline
without adding it and `flexIndices` is empty on every meeting forever: the
client's `applyFlex` becomes a permanent no-op, and the editor's clock silently
disagrees with print on exactly the Phase 2 meetings this decision exists to
protect. It fails in the direction that looks fine. See D7.

### D2 — All three functions are pure, so the browser runs them

`agenda-runsheet.ts`, `agenda-template-rows.ts` and `agenda-timing.ts` import
nothing from `#/db`. Verified: their only imports are each other,
`./speech-window`, `./agenda` and `./meeting-template-limits`.

So the client holds `beats`, `roles` and `slots` and recomputes the whole
timeline locally on every keystroke. No round-trip for the clock. This is what
makes the footer feel like a spreadsheet rather than a form, and it is only
available because the derivation was already pure.

### D3 — Expanded rows, banded by ITERATION, not by beat

The contest stores **15 beats** and prints **21 rows**: `Contest speech` and
`One minute of silence` share a `repeatsRoleKey`, forming a block emitted once
per contestant. A table of the 15 stored beats would report the speeches
costing 8 minutes when they cost 32 — which is precisely the number the officer
opened the editor to find. So the table renders the expanded agenda.

The grouping must follow the emission order, and that order is not what it
looks like. `buildTemplateRows`' block loop is:

```js
repeated.forEach((s, n) => {
  for (const blockRow of block) { out.push(toRow(blockRow, …)) }
})
```

`block` is `[Contest speech, One minute of silence]`, so the output is
**speech1, silence, speech2, silence, speech3, silence, speech4, silence** —
the two beats *interleave*. The speech beat owns rows 1, 3, 5, 7. There is no
contiguous run of "the speech beat's rows" to draw a bracket around. An
earlier draft of this decision specified exactly that bracket; it describes
nothing renderable.

What IS contiguous is the iteration. So:

- The block renders as one band per iteration — `CONTESTANT 1`, `CONTESTANT 2`,
  … — each band holding that iteration's rows in emission order.
- **Band 1 is editable.** Its cells write the shared beats.
- **Bands 2..N collapse by default** to a single line carrying the clock span
  they cover (`CONTESTANT 2–4 · 7:18–7:42 · same as ↑1 · 24`), with a
  disclosure that expands them to full per-row detail. No timing information is
  lost while collapsed, and a six-contestant contest does not bury the closing
  section below the fold.
- Bands 2..N are read-only whether collapsed or expanded. Contest rules give
  every contestant the same window, so nothing legitimate is blocked, and it
  removes the case where you aim at row 3 and hit four rows.

### D4 — Local draft state; the server API is untouched

The table holds the draft in component state. A cell commits on blur through
the existing `updateAgendaRowFn`.

`router.invalidate()` is dropped for **pure** edits (`label`, `detail`,
`minutes`, `flex`, `markGreen/Yellow/Red`) — the server's answer for these is
the value just sent, so re-fetching the route to learn it is waste. It is
**kept** for **structural** edits (`addAgendaRow`, `removeAgendaRow`,
`moveAgendaRow`, `roleKey` / `repeatsRoleKey` changes, and every role
mutation), where the server assigns ordering, ids and slot bindings the client
cannot predict.

Safe on two axes that had to be checked rather than assumed:

- **The server never rewrites an accepted value.** `updateAgendaRow` validates
  with `assertWithin` and *throws* on an over-long label or an out-of-range
  minute; it does not truncate and store something else. So a save that
  resolves leaves the client's optimistic value correct by construction.
- **The first write forks the template and changes every row id, and this
  still holds.** `ensureAgendaDraft` deep-copies a shared template into a
  private one on first write. `findRow` resolves a row id against *both*
  templates (`addressableTemplateIds`) and translates by
  `(templateId, sortOrder)` — a mapping its own docblock notes is exact only
  while the copy is verbatim. It stays verbatim because the only thing that
  renumbers is `renumberRows`, which runs on structural edits, which still
  invalidate. The window where the client holds pre-fork ids is therefore
  exactly the window in which the translation is exact. This is load-bearing
  and non-obvious, so it gets a test (see Testing requirements) rather than a
  comment.

The existing `reseed()`-on-rejection stays exactly as written. Its docblock
already records why: a rejected save produces no re-render, so without it the
field goes on displaying a value that was never saved and looks saved. Dropping
`router.invalidate()` from the success path makes that reasoning *more*
load-bearing, not less, so `reseed()` must not be simplified away in the
rewrite.

### D5 — The footer states the arithmetic; only the ADVICE is deadbanded

`applyFlex` computes `status` with a deadband:

```js
status = Math.abs(deltaMinutes) <= FLEX_TOLERANCE_MINUTES ? "exact" : …
```

with `FLEX_TOLERANCE_MINUTES = 2`. The contest is exactly 2 minutes over, so
`status === "exact"` and `flexBannerMessage` returns **`null`** — nothing at
all — for the meeting that motivated this spec. An earlier draft told the
footer to reuse that function and stopped there.

The deadband is right for a banner, which should not nag about two minutes on a
ninety-minute meeting, and wrong for a readout, whose job is to state the
number. `applyFlex`'s own docblock already draws the line: *"the computed
duration is never deadbanded"* — only `status` is.

So:

- The footer **always** prints `Ends 8:17 · 92 min · slot 90 min · +2`.
  Never suppressed, never rounded, never softened to "on time" when it is not.
- `flexBannerMessage(flex)`'s sentence renders **underneath, only when it is
  non-null** — i.e. outside the deadband. Reused rather than re-written, so the
  editor and the print preview cannot give contradictory advice about the same
  meeting.

**The split is per-section, not speaking-versus-not.** Each section band row
carries its own subtotal (`OPENING 25`, `SPEECHES 39`, `RESULTS AND CLOSING
28`). An earlier draft specified a binary `Speaking 28 · everything else 64`
keyed on `isSpeakerRole`; dropped for two reasons. It restates the complaint
instead of locating it — the actionable finding is that a quarter of a contest
runs before the first speech, which the band subtotal says and the ratio does
not. And it misreads a standard meeting: Table Topics and evaluations are
members speaking, neither role carries `isSpeakerRole`, so both would land in
"everything else" and understate practice time on the 95% of meetings that are
not contests.

Consequence to carry into Phase 2: the standard flow emits **zero** section
rows (`grep -c 'section: true' src/lib/agenda-runsheet.ts` → 0). Bands exist
only on templates, so subtotals show nothing on a standard meeting until
adoption gives it real bands. Adoption should.

### D6 — A row whose length is not yours to set is not an input

`applyFlex` **overwrites** the flex row's minutes:

```js
out = rows.map((r, i) => share.has(i) ? { ...r, minutes: share.get(i) } : r)
```

Table Topics is the single `flex: true` beat in the standard flow, stored at
10, clamped to `[TABLE_TOPICS_MIN, TABLE_TOPICS_MAX]` = `[5, 25]`. Rendered as
an ordinary editable cell, an officer would see 22, type 15, save
successfully — and watch it render 22 again, because D1's pipeline recomputes
it. A control that accepts input and changes nothing is worse than no control.

So a flex row's Min renders as a **derived value with a marker**, not an
input: `22 · stretches 5–25`. You change the other rows and it absorbs the
difference. Beside it, a **pin** control sets `flex = false`, converting the
row into an ordinary editable one — so manual control is available, taken
explicitly, and visible afterwards (`pinned · unpin`).

Rejected: making the cell editable and having a typed value implicitly pin it.
It does what the officer meant, but a row silently stops stretching because it
was touched once, and nothing said so beforehand.

Unreachable in Phase 1 — the contest has no flex beat — and specified now
because D1 commits to the behaviour now.

### D7 — `loadAgendaDraft` gains five fields; `RowPatch` gains one

`AgendaDraft` today carries `templateId`, `templateName`, `editable`, `rows`,
`roles`. The client pipeline in D1 also needs:

- `slots: AgendaSlot[]` — the meeting's `role_slots`, which is what
  `buildTemplateRows` fans the repeat block across and where the holder names
  in the `Who` column come from.
- `scheduledAt`, `timeZone` — for `buildTimeline`.
- `lengthMinutes` — the slot to measure against.
- `geIntroducesFunctionaries` — unused on the template branch, required by
  `resolveAgendaRows`' signature and load-bearing for Phase 2.

And on each row:

- `flex: boolean` — added to `AgendaDraftRow` and selected in
  `loadAgendaDraft`. **Required for D1's correctness**, not only for D6's pin;
  see D1's last paragraph for the silent failure it prevents.

For the pin to be writable, `flex` is also added to `RowPatch` (client), to
`updateAgendaRow`'s patch type (server) and to the zod validator in
`meeting-agenda-edit.ts`. It is the only signature change in Phase 1, it is
optional, and every existing caller keeps working.

All additive; no existing consumer changes. `loadAgendaDraft` is already in
`meeting-agenda-edit-logic.ts`, i.e. on the `-logic` side of the split, so the
new query is reachable from an integration test — which is the reason that
split exists (`club-logic.ts`'s second motive in CLAUDE.md).

### D8 — Deleting a row is undoable, not confirmed

`RowCard.remove()` currently calls `onRemoveRow(row.id)` straight through: no
confirmation, no undo. That was tolerable for tall cards. A dense table puts a
delete control on every line at roughly a third the row height, on a surface
whose entire purpose is moving through it quickly and trimming.

Delete stays immediate. A toast offers **Undo** for ~10 seconds, restoring
through the fns that already exist: `addAgendaRow(predecessorId, kind)` —
which returns the full `AgendaDraftRow`, so its new id is in hand — followed by
`updateAgendaRow(newId, savedPatch)` carrying the label, detail, minutes,
role binding, flex and marks held client-side since the delete. No new server
fn.

Rejected: a confirm dialog per delete. It taxes the deliberate case hardest —
trimming four rows becomes four modals — and a modal shown every time is a
modal nobody reads. Role removal keeps its confirmation, which is a different
thing: it names the people it releases, and that information exists nowhere
else.

### D9 — Numbers live in `lib/`, not in the component

A new pure module `src/lib/agenda-budget.ts` takes the timed rows plus the slot
length and returns the totals, end time, signed delta, status and the
per-section subtotals.

Not in the component and not in a server-fn module, for the reason CLAUDE.md
records twice: a constant defined in a module that imports `#/db` cannot be
imported by a unit test (`DATABASE_URL is not set`), and a schema private to a
server-fn module is invisible to vitest — so the whole layer can be deleted or
have its bounds raised with the suite green. #522 shipped its render caps into
the wrong module *inside the change that cited this trap*.

## Testing requirements

Against the coverage traps in CLAUDE.md, several of which these exist to dodge.

- **`agenda-budget.test.ts` asserts ABSOLUTE values, not relative ones.** The
  real contest fixture — four contestants, 6:45 PM start, 90-minute slot —
  must assert `total === 92`, `endsAt === "8:17"`, `delta === 2`, and the
  subtotals `OPENING === 25`, `SPEECHES === 39`, `RESULTS AND CLOSING === 28`.
  Not `expect(total).toBe(sumOf(rows))`, which passes for every possible bug.
  This is the #519 trap stated as a test.
- **The footer's deadband case, explicitly.** At delta 2 the arithmetic renders
  and `flexBannerMessage` is null; at delta 7 both render. A test that only
  covers delta 7 cannot see the bug D5 exists to fix, because that bug is
  invisible at every delta above the tolerance.
- **A row-by-row clock assertion**, pinning the literal strings `6:45`, `6:55`,
  `7:10`, `7:18`, `7:26`, `7:34`, `7:49`, `8:12`. The per-row `Start` is the
  feature; a total that is right while row 9 is wrong is still a broken editor.
- **A repeat-block case at three arities.** The fixture must run at 4
  contestants *and* at 1 and at 0. At 1, `numbered()` stops numbering
  (`multi ? \`${roleName} ${index + 1}\` : roleName`) and there is no band 2..N
  to collapse; at 0 the block emits nothing and the speeches segment is empty.
  A single-arity fixture is the #522 trap.
- **Band 1 edits write the shared beat exactly once.** Editing the speech
  group's minutes issues ONE `onUpdateRow`, not four. Assert the call, not the
  resulting display. Assert too that bands 2..N expose no editable control —
  the read-only rule is the safety property, and a test of the happy path
  cannot see it disappear.
- **`flex` survives the round trip.** A unit test that the client pipeline
  produces a non-empty `flexIndices` for a fixture with a flex beat. Without
  it, D1's stated silent failure — `applyFlex` no-oping forever because the
  payload dropped one boolean — is invisible to every other test here, since
  the contest fixture has no flex beat and would pass either way.
- **The fork translation under D4.** Fork a shared-template meeting with a
  pure edit, then issue a second pure edit using the PRE-fork row id, and
  assert it lands. This is the non-obvious property D4 rests on; it is
  currently guarded by a docblock.
- **Undo restores every field.** Delete a row carrying label, detail, minutes,
  role binding, flex and all three marks; undo; assert the restored row equals
  the original on all of them and sits at the original position. A test that
  only checks the row came back cannot see a dropped mark.
- **An editor/print parity test on the same fixture.** Cheap because both sides
  call the same functions (D1), and its job is to fail loudly if a later change
  forks the derivation. Explicitly NOT the only guard on the clock — per the
  parity trap it sits *alongside* the absolute golden assertions above, never
  instead of them.
- **`agenda-editor-wiring.guard.test.ts` gains the new prop expressions.** The
  route computes the slot length, the start instant and the slot array and
  passes them in; a prop-fed component test cannot see a WRONG prop (#319 —
  `isMember={shell}`). Extend the existing guard file rather than adding one,
  and read comment-blind via `#/test/guard-source`.
- **Integration coverage for the added `loadAgendaDraft` fields**, in
  `meeting-agenda-edit-logic.integration.test.ts`. Needs `TEST_DATABASE_URL`
  or it silently skips.

## Rollout

**Phase 1 is not coupled to the 2026-09-10 contest, deliberately.**

An earlier draft said "ship before 2026-09-10; the contest is the acceptance
test". That made a one-shot event the verification surface for a rewritten
798-line component, and bought little: the contest is already fixable by hand
in today's editor. Judges' briefing 10 → 8 clears the overrun; trimming the
four opening rows takes the 25-minute opening to about 16. Tedious — that
tedium is the entire reason for Phase 1 — but not blocked, and it carries no
deploy risk.

So: retime the contest by hand now, and ship Phase 1 when it is ready, before
or after the contest. Its acceptance tests are the fixtures above plus one
real templated meeting, not the contest.

Phase 1 touches:

| File | Change |
| --- | --- |
| `src/lib/agenda-budget.ts` | New. Pure. Totals, end time, signed delta, status, per-section subtotals. |
| `src/components/agenda/agenda-editor.tsx` | Card stack → table with iteration bands, computed flex cell, undo. Stays presentational (every mutation is a prop), so it stays reachable from vitest without the Start runtime. |
| `src/server/meeting-agenda-edit-logic.ts` | `loadAgendaDraft` returns the added fields; `updateAgendaRow` accepts `flex` (D7). |
| `src/server/meeting-agenda-edit.ts` | `flex` in the patch validator. |
| `src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx` | Wires the new props. |
| `src/routes/agenda-editor-wiring.guard.test.ts` | Extended for the new prop expressions. |

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

Decisions already taken:

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
- **Adoption must emit section bands.** The standard flow has none, so without
  them an adopted agenda loses D5's subtotals — the one number that locates
  where an hour goes.

Open, to resolve in the Phase 2 spec:

- What happens to a meeting that already forked a private copy when its club
  later sets a default.
- `copyTemplateForMeeting`'s reads of the SOURCE template are uncapped, and are
  safe today only because every source is a seeded template whose size the seed
  fixes. Letting an officer-authored template be a source makes that an
  officer-sized read. TODOS.md already flags it; cap it at the seam, in that
  change.

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
- **Concurrent editors see each other later than before.** Two officers editing
  one agenda is last-write-wins per field, unchanged from today — but dropping
  `router.invalidate()` on pure edits (D4) means a co-editor's change surfaces
  on the next structural edit rather than the next field save. Judged not worth
  a mechanism for a surface used by one officer a few times a month.
- **Bands 2..N cannot be individually retimed.** Correct for a contest by rule;
  a future template that legitimately wants per-iteration durations needs a
  different model than one shared beat.
- **The editor is still officer-only and still a separate page.** Unchanged
  from v1.24.0.0.

## Revised after grilling — what changed and why

Recorded because in three cases the reasoning is worth more than the outcome.

1. **D3's bracket did not exist.** The first draft grouped rows by beat; the
   beats interleave, so the group was non-contiguous and unrenderable. Now
   banded by iteration.
2. **D5 would have shown nothing on the motivating meeting.** `±2` deadband,
   contest is `+2`, `flexBannerMessage` returns null. Found by reading
   `applyFlex`, not by testing the design. The footer now always states the
   arithmetic.
3. **D5's binary split was the wrong metric.** It restated the complaint rather
   than locating it, and misread standard meetings, where Table Topics and
   evaluations are speaking but carry no `isSpeakerRole`.
4. **D6 did not exist.** D1 committed to `applyFlex` without noticing it
   overwrites the flex row, which would have shipped an input that silently
   does nothing.
5. **D7's `flex` field.** Traced from D6, but the real finding is that D1 was
   already broken without it — `applyFlex` would no-op forever, failing in the
   direction that looks fine.
6. **D8 did not exist.** A denser table makes the unprotected one-click delete
   materially riskier than it was for cards.
7. **The Sep 10 coupling was removed.** It made a one-shot event the acceptance
   test for a large rewrite, to buy convenience on a task that was already
   possible by hand.
