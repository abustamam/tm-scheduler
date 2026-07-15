ALTER TABLE "path_level_progress" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "path_level_progress" ADD COLUMN "credited_club_id" uuid;--> statement-breakpoint
ALTER TABLE "path_level_progress" ADD CONSTRAINT "path_level_progress_credited_club_id_clubs_id_fk" FOREIGN KEY ("credited_club_id") REFERENCES "public"."clubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "path_level_progress_credited_club_idx" ON "path_level_progress" USING btree ("credited_club_id");