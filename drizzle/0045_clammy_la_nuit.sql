ALTER TABLE "clubs" ADD COLUMN "ge_introduces_functionaries" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Every club gets the corrected default (the Toastmaster of the Day introduces
-- the functionaries), except MCF, which genuinely runs the General Evaluator
-- variant in the room — see #367. Matching on the immutable club number OR the
-- slug means this finds MCF whichever of the two identifies it in a given
-- environment (prod has both; a seeded/dev database may have only the slug).
--
-- Deliberately a bare UPDATE: migrations run at container startup ahead of the
-- server (`node .output/migrate.mjs && node .output/server/index.mjs`), so a
-- statement that could throw on a database without MCF — a fresh dev DB, CI, a
-- new deployment — would block startup for EVERY club. Matching zero rows is a
-- no-op, and re-running is idempotent.
UPDATE "clubs" SET "ge_introduces_functionaries" = true
WHERE "club_number" = '28677176' OR "slug" = 'mcf-toastmasters';
