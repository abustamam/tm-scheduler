-- #423: remove unsuffixed project rows the seed added to LEGACY paths.
--
-- TI revised the Pathways projects and kept the superseded editions for members
-- already on a legacy path. Base Camp returns every project on those paths with
-- a " (Legacy)" suffix — required and elective alike — so these are different
-- projects, not a different spelling of the same one. Confirmed against a full
-- 8705 /detail payload (2026-07-27), right down to "Reflect on Your Path
-- (Legacy)".
--
-- #412 seeded the unsuffixed names from toastmasters.org, whose legacy path
-- pages show the CURRENT project names. That put ~22 rows on prod describing
-- projects nobody on those paths is taking, alongside the real suffixed rows
-- Base Camp had already derived — so a member would see each Level 1 project
-- twice once the picker (#418) enumerates this table.
--
-- Ordering note: the container CMD runs migrations, then the catalog seed, then
-- the server. So this deletes the wrong rows and the seed immediately reinserts
-- the correct suffixed ones in the same boot.
--
-- Guarded three ways, in decreasing order of how much I trust the premise:
--   * bcm_block_id IS NULL — never touch a row Base Camp has corroborated. This
--     alone makes the statement safe even if the suffix theory is wrong.
--   * no speech references it — speeches.project_id is ON DELETE SET NULL, so
--     deleting a referenced row silently unlinks a member's history.
--   * only on paths marked legacy, and only names lacking the suffix.
--
-- Idempotent, and a no-op on a database that was never seeded.
DELETE FROM "pathways_projects" p
USING "pathways_paths" pa
WHERE p."path_id" = pa."id"
  AND pa."status" = 'legacy'
  AND p."name" NOT LIKE '% (Legacy)'
  AND p."bcm_block_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "speeches" s WHERE s."project_id" = p."id"
  );
