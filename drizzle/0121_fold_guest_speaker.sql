-- #1208: a guest speaker is not a guest kind, it is a guest holding a speech. Fold
-- `guest_speaker` into `visiting_toastmaster` (the schema's own definition: a
-- Toastmaster from another club who speaks; `home_club` is kept) and drop the enum
-- value so nothing can write it again.
--
-- The data step is lossy: afterwards a former guest speaker cannot be told from a
-- visiting Toastmaster. Postgres cannot drop an enum value in place (precedent:
-- 0014), so: convert the rows, drop the default, swap the column to text, drop the
-- old type, create the narrowed type, cast back, restore the default. Every value
-- is 'visitor' or 'visiting_toastmaster' after the UPDATE, so the cast is total.
UPDATE "guests" SET "kind" = 'visiting_toastmaster' WHERE "kind" = 'guest_speaker';--> statement-breakpoint
ALTER TABLE "guests" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "guests" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."guest_kind";--> statement-breakpoint
CREATE TYPE "public"."guest_kind" AS ENUM('visitor', 'visiting_toastmaster');--> statement-breakpoint
ALTER TABLE "guests" ALTER COLUMN "kind" SET DATA TYPE "public"."guest_kind" USING "kind"::"public"."guest_kind";--> statement-breakpoint
ALTER TABLE "guests" ALTER COLUMN "kind" SET DEFAULT 'visitor';
