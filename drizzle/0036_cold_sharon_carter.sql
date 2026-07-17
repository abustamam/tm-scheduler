ALTER TABLE "clubs" ALTER COLUMN "reminder_enabled" SET DEFAULT false;--> statement-breakpoint
-- Soft launch: role reminders are opt-in per club. #274 backfilled every existing
-- club to `true` (its original default); flip them all off so no club emails on the
-- #272 deploy. A club turns reminders on deliberately from /admin/club-settings.
UPDATE "clubs" SET "reminder_enabled" = false;