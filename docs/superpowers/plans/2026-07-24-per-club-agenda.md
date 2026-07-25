# Per-club agenda — implementation plan (#368 → #367)

Executes `docs/superpowers/specs/2026-07-24-per-club-run-of-show-design.md` plus #368.
One branch, one PR, commits separated per task. #368 must land before #367's adaptation works.

## Task 1 — role_definitions: `enabled` + `key` (#368)

Schema + migration only. No behavior change beyond slot generation.

- `role_definitions.enabled boolean not null default true`
- `role_definitions.key text` (nullable — custom club roles have none)
- Migration backfills `key` for rows whose `name` matches a `ROLE_TEMPLATE` entry
  (`'toastmaster_of_the_day'`, `'table_topics_master'`, `'speaker'`, `'evaluator'`,
  `'general_evaluator'`, `'timer'`, `'ah_counter'`, `'grammarian'`, `'vote_counter'`).
- `ROLE_TEMPLATE` gains `key` so new clubs seed it.
- `generateSlotRows` skips disabled roles.
- Partial unique index on `(club_id, key) where key is not null`.

## Task 2 — enable/disable lifecycle + UI (#368)

- Server: toggling `enabled` false deletes the role's **open, unclaimed** slots on future
  non-cancelled meetings; **claimed slots are kept** and the count is returned so the UI can
  report it. Toggling true backfills open slots onto the same set of meetings — reuse
  `applyTemplateSyncToUpcomingMeetings` rather than writing new sync.
- Past meetings are never touched.
- Roles admin page (`src/routes/_authed/admin/roles.tsx`): enable/disable control, disabled rows
  visually distinct, still listed.
- Disabled roles are excluded from: the "+ Add role" picker, the printable club role sheet, and
  any club role listing used for assignment.

## Task 3 — the run-of-show builder (#367)

- `buildRunOfShow({ geIntroducesFunctionaries }): Beat[]` in `src/lib/` — pure, no db.
- Corrected default template per the spec's table (TM introduces functionaries; GE splits into
  evaluate-evaluators / call-for-reports / overall).
- `expandRunSheet`: a plain-role beat with **no matching slots is omitted** instead of degrading
  to a label-only row. Unclaimed-but-present slots still render as open.
- No Timer role ⇒ the three "Timer's report · vote Best X" beats become Toastmaster-run
  "vote Best X" rather than disappearing.

## Task 4 — club flag, settings toggle, deck (#367, absorbs #353)

- `clubs.ge_introduces_functionaries boolean not null default false`; migration flips MCF by slug.
- Toggle on `src/routes/_authed/admin/club-settings.tsx`.
- `buildSlideDeck` takes an options object (it would otherwise reach six positional params) and
  the same config.
- Standard flow: the `geIntro` slide becomes a Toastmaster-owned functionary slide listing each
  functionary and its holder. MCF keeps the GE-owned variant behind the flag.
- New report slide for beat 12 (absorbs #353), rendering only for functionary roles with slots.

## Task 5 — parity + suite green

- Parity test: printed run sheet and deck agree on section order across the flag × role-set matrix.
- Update existing print/deck tests for the corrected default. That diff is the review artifact.
- `bun run typecheck`, `bun run check`, and the full suite green with `TEST_DATABASE_URL` set.
