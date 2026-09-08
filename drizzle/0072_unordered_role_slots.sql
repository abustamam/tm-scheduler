ALTER TABLE "meeting_template_roles" ADD COLUMN "slots_unordered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD COLUMN "slots_unordered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill (#624). Materialization is copy-once, so the seed's new flag reaches no
-- club that has already run a contest — and a club with a contest on the calendar
-- is exactly who this fix is for. Every row that already exists for the contest's
-- contestant role is flagged: the global template's own declaration, every private
-- per-meeting copy of it, and every club's materialized definition.
--
-- Keyed on `key`, never `name`: a club may have renamed "Contestant" (#445), and
-- the key is the stable identity (#368). Scoped to template-materialized rows on
-- `role_definitions` (`template_id IS NOT NULL`) because no seed writes this key
-- into a club's standard roles, so a standard-scope row carrying it is a club's
-- own and not ours to flag. A NULL key (a club-invented role) never matches the
-- equality, so those are left alone either way.
--
-- Idempotent: re-running flags rows that are already flagged.
-- `src/server/unordered-role-slots-backfill.integration.test.ts` runs these two
-- statements against seeded rows, so a regenerated file that lost them fails there.
UPDATE "meeting_template_roles" SET "slots_unordered" = true WHERE "key" = 'contestant_prepared';--> statement-breakpoint
UPDATE "role_definitions" SET "slots_unordered" = true WHERE "key" = 'contestant_prepared' AND "template_id" IS NOT NULL;
