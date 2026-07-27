-- #424: remove "Reflect on Your Path" rows wrongly filed at level 5.
--
-- toastmasters.org draws this project inside the Demonstrating Expertise column,
-- so #412 seeded it as a level 5 required project on all 11 paths. Base Camp
-- disagrees, and Base Camp is right: it ships path completion as its OWN
-- chapter, a sibling of Level 1..Level 5, holding this one project. Confirmed in
-- real /detail payloads for 8711 and 8705 (the latter as "Reflect on Your Path
-- (Legacy)"), and the maintainer confirms it is not a level 5 item — it is a
-- reflection on the path as a whole, taken once the levels are done.
--
-- The evidence was already in the audit before the payloads arrived: this was
-- the ONLY suspect row on all three cleanly-synced paths, because reconciliation
-- could never stamp a project Base Camp does not return at that level.
--
-- The parser now ingests the Path Completion chapter at the sentinel level, and
-- the catalog seeds it there. Migrations run before the seed in the container
-- CMD, so the mis-levelled rows go and the correct ones arrive in the same boot.
--
-- Deletes rather than re-levels, deliberately: an UPDATE to level 6 would
-- collide with the row the seed is about to insert on the (path_id, level, name)
-- unique index, and these rows carry no state worth preserving — they were never
-- stamped, by definition, since Base Camp never returned them here.
--
-- Guarded on bcm_block_id IS NULL, which alone keeps this safe if the premise is
-- wrong, and on no speech referencing the row (speeches.project_id is ON DELETE
-- SET NULL, so deleting a referenced row silently unlinks a member's history).
-- Matches the legacy suffix too.
--
-- Idempotent, and a no-op on a database that was never seeded.
DELETE FROM "pathways_projects" p
WHERE p."level" = 5
  AND (p."name" = 'Reflect on Your Path' OR p."name" = 'Reflect on Your Path (Legacy)')
  AND p."bcm_block_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "speeches" s WHERE s."project_id" = p."id"
  );
