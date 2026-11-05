ALTER TABLE "meetings" ADD COLUMN "slot_date" date;--> statement-breakpoint
-- #1521: backfill each existing meeting with its current club-local date.
UPDATE "meetings" SET "slot_date" = (("scheduled_at" AT TIME ZONE (SELECT "timezone" FROM "clubs" WHERE "clubs"."id" = "meetings"."club_id"))::date) WHERE "slot_date" IS NULL;
