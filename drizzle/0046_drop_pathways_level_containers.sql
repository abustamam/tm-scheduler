-- #415: remove level-container rows wrongly ingested as required PROJECTS.
--
-- Base Camp ships each level's own introduction unit as a `sequential` node with
-- a real block_id, sitting alongside that level's actual projects, so
-- `parseDetailPayload` derived it into `pathways_projects` as a required
-- project. Production held 22 of these: "Level 1: Mastering Fundamentals" …
-- "Level 5: Demonstrating Expertise" on each current path, plus "Path
-- Introduction" on each legacy one. They are what made Base Camp report
-- `total: 5` for a Level 1 that really has four projects.
--
-- The parser now skips them, but that only stops new ones; these already exist
-- and, under #420, would appear in the project picker as selectable required
-- projects on every club.
--
-- Guarded two ways:
--   * `speeches` — `speeches.project_id` is ON DELETE SET NULL, so deleting a
--     referenced row would silently unlink a member's speech from its project.
--     No speech should reference a container, but that is not worth assuming;
--     any that does keeps its row and is left for a human.
--   * name pattern — deliberately narrow. No real Pathways project is named
--     "Path Introduction" or begins "Level N:".
--
-- `bcm_project_progress.project_id` is ON DELETE CASCADE, so the mirror rows for
-- these containers go with them. That is correct: they mirror a non-project, and
-- the next sync will not recreate them.
--
-- Idempotent, and a no-op on any database that never synced (including a fresh
-- one), since these rows only ever came from a /detail sync.
DELETE FROM "pathways_projects" p
WHERE (p."name" ~ '^Level [1-5]:' OR p."name" = 'Path Introduction')
  AND NOT EXISTS (
    SELECT 1 FROM "speeches" s WHERE s."project_id" = p."id"
  );
