ALTER TABLE "speeches" ADD COLUMN "delivered_off_schedule" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "speeches" ADD COLUMN "delivered_year" smallint;--> statement-breakpoint
ALTER TABLE "speeches" ADD COLUMN "delivered_month" smallint;--> statement-breakpoint
ALTER TABLE "speeches" ADD COLUMN "recorded_club_id" uuid;--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_recorded_club_id_clubs_id_fk" FOREIGN KEY ("recorded_club_id") REFERENCES "public"."clubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_delivered_date_valid" CHECK (("speeches"."delivered_month" is null or ("speeches"."delivered_year" is not null and "speeches"."delivered_month" between 1 and 12)) and ("speeches"."delivered_year" is null or "speeches"."delivered_year" between 1900 and 2100));--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_delivered_date_only_off_schedule" CHECK ("speeches"."delivered_off_schedule" or ("speeches"."delivered_year" is null and "speeches"."delivered_month" is null and "speeches"."recorded_club_id" is null));--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_off_schedule_member_only" CHECK (not "speeches"."delivered_off_schedule" or "speeches"."person_id" is not null);