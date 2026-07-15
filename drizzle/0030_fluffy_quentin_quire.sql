CREATE TYPE "public"."recurrence_mode" AS ENUM('interval', 'monthly');--> statement-breakpoint
CREATE TABLE "club_meeting_recurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"mode" "recurrence_mode" NOT NULL,
	"weekday" integer NOT NULL,
	"interval_weeks" integer,
	"anchor_date" text,
	"ordinals" text[],
	"time_of_day" text NOT NULL,
	"location" text,
	"keep_ahead" integer DEFAULT 4 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "club_meeting_recurrence_club_id_unique" UNIQUE("club_id"),
	CONSTRAINT "club_meeting_recurrence_mode_fields_check" CHECK ((
				("club_meeting_recurrence"."mode" = 'interval' AND "club_meeting_recurrence"."interval_weeks" IS NOT NULL AND "club_meeting_recurrence"."interval_weeks" >= 1 AND "club_meeting_recurrence"."anchor_date" IS NOT NULL AND "club_meeting_recurrence"."ordinals" IS NULL)
				OR
				("club_meeting_recurrence"."mode" = 'monthly' AND "club_meeting_recurrence"."ordinals" IS NOT NULL AND cardinality("club_meeting_recurrence"."ordinals") >= 1 AND "club_meeting_recurrence"."interval_weeks" IS NULL AND "club_meeting_recurrence"."anchor_date" IS NULL)
			)),
	CONSTRAINT "club_meeting_recurrence_bounds_check" CHECK ("club_meeting_recurrence"."weekday" >= 0 AND "club_meeting_recurrence"."weekday" <= 6 AND "club_meeting_recurrence"."keep_ahead" >= 1 AND "club_meeting_recurrence"."keep_ahead" <= 52)
);
--> statement-breakpoint
DROP INDEX "meetings_club_scheduled_idx";--> statement-breakpoint
ALTER TABLE "club_meeting_recurrence" ADD CONSTRAINT "club_meeting_recurrence_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_club_scheduled_unique" ON "meetings" USING btree ("club_id","scheduled_at");