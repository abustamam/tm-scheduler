# Configurable agendas — design

Date: 2026-08-21
Status: Approved for implementation planning
Phase: 2 of 2 (supersedes parts of `2026-08-19-agenda-templates-design.md` — see **Superseded decisions**)

## Problem

Phase 1 shipped meeting templates as *data* but left the seed as the only writer. The stated
intent behind the work was **configurable agendas**; what exists is one hardcoded global
template that no club can edit, add to or trim. A club whose meeting is a shape nobody
anticipated is no better off than before the feature.

Three concrete defects make this visible, all confirmed by running the real
`buildTemplateRows` against a club that has deleted every slot it is permitted to delete
(4 impromptu contestants, 4 evaluation contestants, the test speaker):

```
  0m  == SECTION == IMPROMPTU SPEAKING CONTEST
  3m  Impromptu contest briefing · — open —
 10m  Break
  0m  == SECTION == SPEECH EVALUATION CONTEST
  3m  Evaluation contest briefing · — open —
  7m  Test speech
  5m  Evaluation preparation
```

1. **Beats have no gating, by explicit decision.** Phase 1's D1 omitted the
   `requiresAnyOf` / `fallbacks` machinery on the reasoning that "a contest's shape is fixed by
   the contest rules and does not adapt to which roles a club runs." That is true of *one*
   contest and false of *which contests run on a given night*. Section bands, chair briefings,
   the break and the evaluation-prep window bind to no contestant role, so nothing an officer
   can do removes them.
2. **A role beat with zero slots still prints.** `buildTemplateRows` deliberately emits a bare
   role row when a role has no slot, "so the contest's shape survives an unfilled position."
   Correct for an unfilled Chief Judge; wrong for a contest that is not happening. Unreachable
   by any UI action.
3. **A non-repeating role beat emits one row per slot.** `ballot_counter: 2` prints "Tallying 1"
   and "Tallying 2" at 10 minutes each; `contest_timer: 2` prints "Timers' report" twice at 3
   minutes. Two ballot counters perform one tally together. 13 invented minutes on every
   contest, including one running all three events.

The obvious escape hatch is deliberately welded shut: `resolveMeetingRoleDefs` skips the
`enabled` filter when `templateId` is non-null ("a template's roles are the contest's fixed
shape, not a menu"), so the club roles page cannot switch a contest off either.

## What Phase 2 ships

- **Per-meeting agenda editing** for club `admin`: add, remove, reorder, retime and rename
  rows; add section bands; set timing marks; bind a row to a role, including creating a role
  for that meeting so the row is claimable.
- **A private template per meeting**, so editing one night's agenda never alters another's.
- Deletion of the shipped three-contest `speech_contest` template, replaced by a starting
  point that reflects a real event (see **Rollout, Track A**). Zero meetings reference the
  existing row — verified against production on 2026-08-21 — so it can be deleted rather
  than disabled.
- Measured caps in `meeting-template-limits.ts`, replacing the current unprofiled bounds.
- `seedGlobalTemplates()` in the container startup chain, so a seeded template reaches
  production on deploy rather than through an SSH tunnel to the database.

## What Phase 2 does NOT ship

- **No editing of standard meetings.** A meeting with `template_id IS NULL` keeps reading the
  code-derived `RUN_OF_SHOW`. Print, present mode, the `.pptx` export, minutes, DCP and
  `agenda-parity.test.ts` are all out of scope by construction.
- **No "save as template".** Promoting an edited meeting's shape into a reusable club template
  is the natural follow-on and the storage is designed for it (clear the meeting marker), but
  it is not in this phase.
- **No beat gating.** Explicitly dropped: see D6.
- **No template gallery, sharing or cross-club templates.**

## Decisions

### D1 — Each templated meeting owns a private template

Applying a template deep-copies it — the `meeting_templates` row, its
`meeting_template_roles` and its `meeting_template_beats` — into a new row owned by the club
and marked as belonging to that meeting. `meetings.template_id` points at the copy.

`meeting_templates` gains a nullable `meeting_id` referencing `meetings` with
`ON DELETE CASCADE`. Non-null means "one meeting's private copy, not something anyone picks":
`listAvailableTemplates` filters those out, and every other consumer treats them as ordinary
templates.

Rejected alternatives:

- **A per-meeting override/delta table.** Two sources of truth for one agenda. Every reader
  must apply the patch, insertion ordering is fiddly, and a later edit to the shared template
  shifts underneath the overrides.
- **One JSONB run-of-show on `meetings`.** Loses the foreign keys the slot machinery depends
  on — role bindings become untyped strings — and is against the grain of a schema that is
  relational down to the timing marks.

The chosen shape needs no new tables, reuses the copy-once precedent the codebase already
adopted for `role_definitions`, and keeps exactly one read seam so print, present mode and
the export need no changes.

Cost accepted: each templated meeting materializes its own role-definition rows (~10 for a
contest). Contests are a few nights a year; this is the same bloat copy-once already accepts
per club+template.

### D2 — Reverting deletes the private copy; re-converting makes a fresh one

Converting back to a standard meeting nulls `template_id` and deletes the private template
row. Re-converting copies afresh, so an edited contest never leaks into the next one. This
keeps "a meeting's agenda is its own" true without a reset affordance.

### D3 — Two index changes, and one trap to verify

`meeting_templates_club_key_unique` is on `(club_id, key) WHERE club_id IS NOT NULL`. Two
contest meetings in one club would collide on `speech_contest`, so its predicate gains
`AND meeting_id IS NULL`. A new `uniqueIndex` on `(meeting_id) WHERE meeting_id IS NOT NULL`
enforces one private template per meeting at the database.

**`db:push` does not update a partial index's `WHERE` predicate on an index that already
exists.** This repo has already lost time to exactly this on
`role_definitions_club_key_unique`: the migration emitted a correct `DROP` + `CREATE`, and
`db:push` left the old predicate on `tm_test` while creating the new sibling beside it, so the
test database enforced a constraint the schema no longer declared. After syncing `tm_test`,
verify with `select indexdef from pg_indexes where indexname = 'meeting_templates_club_key_unique'`
and recreate by hand if stale.

### D4 — A role row is "once" or "per holder"

This replaces both `repeats_role_key` and the implicit per-slot fan-out with one officer-facing
setting:

- **once** (default) — one row, whoever holds the role. Fixes defect 3: a joint tally prints
  once.
- **per holder** — one row per slot. On a single row this is today's fan-out; on consecutive
  rows it is today's repeat block.

Two shapes recorded as undecided in `TODOS.md` — a block with two role-owning rows, and a role
row whose own role differs from its repeat key — become **unauthorable** rather than untested.
That closes the TODO by constraining the editor instead of specifying semantics nobody wants.

Changing the default to "once" alters the seeded contest's output. That is the intended fix,
and it reaches templated meetings only; standard nights do not read template beats.

### D5 — An empty agenda is legal

`loadTemplateContent` currently treats "no beats AND no roles" as "no such template", and its
own comment flags this as a Phase 2 problem. Today that makes `meetings.ts:331` throw
`references template X, which has no beats or roles` — so an officer deleting the last row
would break the meeting page. The check becomes a real existence check on the template row.
Building an agenda up from nothing is a legitimate state.

### D6 — Beat gating is dropped

An earlier proposal added `requires_role_key` so a beat disappears when its contest has no
contestants. The editor supersedes it: you delete the rows you do not want rather than having
the system infer it. Carrying both would be two mechanisms for one job.

### D7 — The editor is a page, gated on a real session

A dedicated route inside the club shell, reached from the meeting page beside "Change meeting
type". Twenty-six rows with reorder, per-row minutes, marks and role binding does not fit a
dialog, and keeping it off the meeting route stops that loader growing an editor's worth of
state.

Writes gate on `requireClubRole(["admin"])` — the same gate as `addRoleSlot` and
`removeRoleSlot` — plus `assertClubNotArchived` and `assertMeetingNotLocked`. Deliberately
**not** the self-asserted TMOD arm: that path is honour-system (a member id compared against
the meeting's TMOD slot, no session), and rewriting a run of show is not something an
unauthenticated claim should reach.

Every write lives in a `*-logic.ts` sibling. A `createServerFn` handler is unreachable from
vitest, so logic inside one can be neither integration-tested nor guarded.

### D8 — Deleting a role names the people it releases

Role deletion releases slots, and a released holder **cannot be notified**:
`notifications.slot_id` is `NOT NULL` and `ON DELETE CASCADE` to `role_slots`, so a row
enqueued against a slot the same transaction deletes is destroyed before the poller sees it.
The editor reuses the conversion dialog's approach — name the affected people, instruct the
officer to message them — rather than inventing a second, quieter path to the same loss.

## Testing requirements

These are requirements, not suggestions; each maps to a failure this repo has actually had.

1. **Measure the caps.** `meeting-template-limits.ts` carries a standing instruction that its
   ceilings are bounds nobody profiled and must be reset before an editor exists. Run the cost
   curve, then set absolute ceilings below the knee.
2. **Assert absolute numbers, never relative to the constant.** `expect(x).toBeLessThanOrEqual(CAP)`
   passes for every value of `CAP`, including one that reintroduces the problem (#519: raising
   `speakerRows` to 5,000 kept 90/90 green while one request blocked the event loop for 129
   seconds).
3. **Profile hostile character classes, not ASCII.** #522 measured emoji rows at ~13× ASCII
   through the same renderer at the same capped size. An all-ASCII fixture sized a cap 3× too
   high.
4. **Build the fixture matrix from a written list of unbounded axes**, and include the case
   where all of them are at their ceiling at once. The axes here: label length, detail length,
   beat count, role count, repeat-slot count, club name, club logo. The role sheets' one-page
   promise was wrong four times in a row from varying one axis at a time.
5. **Geometry needs a real engine.** A user-authored 60-row agenda is a print-layout question
   and jsdom performs no layout. `print-page-count.test.tsx` and `print-density.test.tsx` are
   the only gates that can see it; they skip silently without `CHROME_PATH`, which reads
   exactly like passing. Local runs use the Playwright `chrome-headless-shell`; CI is the real
   signal.
6. **Export `TEST_DATABASE_URL` or ~630 integration tests vanish while the run still reads
   green.** On the maintainer's Mac the test database is on port **5433**.
7. **A club-less row must clean itself up.** Global templates have `club_id IS NULL`, so
   `cleanup(clubId)` cannot cascade to them. Per-run key suffixes, track created ids, delete
   only those, scope every assertion to your own club.
8. **The editor route's wiring gets a comment-blind source guard.** A route cannot be mounted
   in vitest and a prop-fed component test cannot see a wrong prop (#319).
9. **Assert the observable a guard controls, not the result.** An empty-list short-circuit
   returns the same value whether it runs or not; count statements at the driver
   (`statementsDuring` / `readsOf`), and assert the list is non-empty before trusting a count.

## Rollout

Two tracks, so a real event on ~2026-09-11 does not depend on the editor landing.

### Track A — the night is safe (data only, this week)

A corrected seed plus the startup-seed fix. No schema change, no editor, shippable in a day.

The event is **in-person, prepared speeches only, and explicitly not an International Speech
Contest** — no evaluation contest, no Table Topics contest, no Tall Tales. Three parameters
are required before writing the seed and are inputs rather than open design:

- whether it is judged (which decides whether Chief Judge, judges, ballot counters, tallying
  and results/certificates exist at all, or whether the club's existing Best Speaker ballot
  covers it),
- how many speeches,
- the speech length, which sets the green/yellow/red marks.

`seedGlobalTemplates()` joins the Docker `CMD` chain beside `seed-catalog.mjs`. The bundled
entry must call the function **explicitly** rather than relying on the script's
`import.meta.main` guard: Bun and Node 24 honour it, the `node:22-slim` runtime image does
not, so a guard-dependent entry would run in the container and silently do nothing — the same
silently-absent-gate shape this repo keeps getting caught by.

### Track B — the editor

As designed above, without deadline pressure. Authoring the event's shape through the editor
becomes the dogfood test rather than the only path.

## Accepted limitations

- **A standard meeting still cannot be edited.** A club wanting a different Thursday shape
  must convert it to a template first.
- **Editing is per meeting, so a recurring shape is re-authored each time** until "save as
  template" ships.
- **Private templates accumulate role-definition rows** — ~10 per templated meeting. Bounded
  by how often clubs run non-standard nights.
- **A completed meeting's agenda is frozen.** `assertMeetingNotLocked` applies, so a
  correction after the fact is not possible through the editor.

## Superseded decisions

From `2026-08-19-agenda-templates-design.md`:

- **D1** ("a template's run of show is flat; no gating") — narrowed. Flatness stands; the
  reasoning that a template never needs to adapt does not, and D4 above replaces the
  fan-out half of it.
- **D4** (repeat blocks keyed on `repeats_role_key`) — replaced by D4 above.
- **"Templates are added by GavelUp, not by clubs"** (v1.21.0.0 known limits) — no longer
  true once this ships.
