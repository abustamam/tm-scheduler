ALTER TABLE "clubs" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "club_number" text;--> statement-breakpoint
-- Backfill existing rows (mirrors src/lib/slug.ts) so NOT NULL/unique can apply.
UPDATE "clubs" SET "slug" = trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')) WHERE "slug" IS NULL;--> statement-breakpoint
-- One-time launch values for MCF (deploy is self-completing; seed script does not run in prod).
UPDATE "clubs" SET "slug" = 'mcf-toastmasters', "club_number" = '28677176' WHERE "name" = 'MCF';--> statement-breakpoint
ALTER TABLE "clubs" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_club_number_unique" UNIQUE("club_number");
