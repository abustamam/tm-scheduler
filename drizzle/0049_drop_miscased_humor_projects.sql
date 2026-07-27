-- #429: remove seeded rows that differ from a real Base Camp project only by
-- capitalisation.
--
-- TI is not case-consistent with itself. toastmasters.org writes "Engage Your
-- Audience With Humor" and "Deliver Your Message With Humor"; Base Camp returns
-- both with a lowercase "with". The catalog followed the website, so the seed
-- inserted a second row beside the one reconciliation had already derived —
-- `pathways_projects` is unique on (path_id, level, name), and that index is
-- case-sensitive, so the two spellings coexist happily.
--
-- #413 made reconciliation's name match case-insensitive, which fixes this for a
-- FRESH database (the seeded row exists first and gets stamped). It cannot fix a
-- database where the derived row landed first: step 1 matches that row by
-- `bcm_block_id` and returns before step 2 is ever reached. Prod is in exactly
-- that state, which is why the capitalised rows showed up as SUSPECT in the
-- 2026-07-27 audit while their lowercase twins sat in SEED GAPS.
--
-- TWO clauses, because one alone leaves a hole:
--
--   (a) generic — an unstamped row differing only by case from a STAMPED sibling
--       at the same (path, level). Catches this defect and any future casing
--       drift, and is unambiguous: the stamped row is Base Camp's own spelling.
--
--   (b) the two specific strings. Needed because on a database that seeded but
--       never synced 8711, NEITHER spelling is stamped, so (a) matches nothing
--       and the re-seed would leave both. Safe to name them outright: real
--       payloads (2026-07-27) show Base Camp writes "with", so these exact
--       capitalised strings are not project names TI uses anywhere.
--
-- Verified on the dev database, which reproduced both situations.
--
-- Guarded on the doomed row being unstamped — so a Base Camp-corroborated row is
-- never at risk — and on no speech referencing it, since speeches.project_id is
-- ON DELETE SET NULL and would silently unlink a member's history.
--
-- Idempotent, and a no-op on a database that was never seeded.
DELETE FROM "pathways_projects" p
WHERE p."bcm_block_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "speeches" s WHERE s."project_id" = p."id"
  )
  AND (
    -- (a)
    EXISTS (
      SELECT 1
      FROM "pathways_projects" other
      WHERE other."path_id" = p."path_id"
        AND other."level" = p."level"
        AND other."id" <> p."id"
        AND other."bcm_block_id" IS NOT NULL
        AND lower(other."name") = lower(p."name")
    )
    -- (b)
    OR p."name" IN (
      'Engage Your Audience With Humor',
      'Deliver Your Message With Humor'
    )
  );
