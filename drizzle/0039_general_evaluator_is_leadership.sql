-- Recategorize General Evaluator as a leadership role for existing clubs.
--
-- The GE runs the evaluation team rather than evaluating a speech, so it belongs
-- with the leadership roles. ROLE_TEMPLATE (src/lib/role-template.ts) now seeds
-- it that way; this brings clubs created before that change into line.
--
-- Two behavior changes this drives, both intended:
--   * The agenda screen groups slots into sections by category, so the GE now
--     renders under "Leadership" instead of "Evaluation".
--   * Best Evaluator award eligibility is built from evaluator-category slots
--     (src/server/minutes-logic.ts), so the GE is no longer offered as a
--     candidate — that award is for speech evaluators.
--
-- NOT affected: the printed agenda / runsheet, which orders beats by role NAME
-- from a fixed template (src/lib/agenda-runsheet.ts), and the speaker↔evaluator
-- pairing heuristic, which already preferred "Evaluator" (3 slots) over the GE.
--
-- Scoped to rows that are still 'evaluator', so this is idempotent and leaves a
-- club that already recategorized its GE by hand untouched.

UPDATE "role_definitions"
SET "category" = 'leadership'
WHERE "name" = 'General Evaluator' AND "category" = 'evaluator';
