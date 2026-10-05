DROP TABLE "notifications" CASCADE;--> statement-breakpoint
ALTER TABLE "clubs" DROP COLUMN "reminder_enabled";--> statement-breakpoint
ALTER TABLE "clubs" DROP COLUMN "reminder_lead_time_days";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "reminder_opt_out";