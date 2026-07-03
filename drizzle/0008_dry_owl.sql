ALTER TABLE "clubs" ADD COLUMN "default_meeting_minutes" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "length_minutes" integer DEFAULT 90 NOT NULL;