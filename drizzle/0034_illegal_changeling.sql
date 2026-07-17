ALTER TABLE "clubs" ADD COLUMN "reminder_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "reminder_lead_time_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "reminder_opt_out" boolean DEFAULT false NOT NULL;