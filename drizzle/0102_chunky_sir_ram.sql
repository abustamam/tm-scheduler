-- New-member orientation (#940). HAND-EDITED from drizzle-kit's output, which
-- emitted ONE statement: ADD COLUMN "orientation_started_at" timestamp DEFAULT now().
-- In Postgres that fills every EXISTING row with now(), putting every veteran
-- member in orientation. Adding the column with no default leaves existing rows
-- NULL (not in orientation); the separate SET DEFAULT then applies only to rows
-- inserted afterwards. The snapshot is kept as generated, so `db:generate`
-- reports no drift. Pinned by `orientation-migration.test.ts`.
ALTER TABLE "members" ADD COLUMN "orientation_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "orientation_started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "orientation_dismissed_at" timestamp;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "basecamp_setup_at" timestamp;
