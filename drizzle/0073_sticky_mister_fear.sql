CREATE TYPE "public"."timing_granted_via" AS ENUM('officer', 'tmod', 'self');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'timing_record';--> statement-breakpoint
CREATE TABLE "meeting_timings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"elapsed_seconds" integer NOT NULL,
	"mark_green" real,
	"mark_yellow" real,
	"mark_red" real,
	"recorded_by_member_id" uuid,
	"granted_via" "timing_granted_via" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_timings_elapsed_nonneg" CHECK ("meeting_timings"."elapsed_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "meeting_timings" ADD CONSTRAINT "meeting_timings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_timings" ADD CONSTRAINT "meeting_timings_slot_id_role_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."role_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_timings" ADD CONSTRAINT "meeting_timings_recorded_by_member_id_members_id_fk" FOREIGN KEY ("recorded_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_timings_meeting_idx" ON "meeting_timings" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_timings_slot_unique" ON "meeting_timings" USING btree ("slot_id");