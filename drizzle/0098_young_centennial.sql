CREATE TABLE "role_feedback_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"role_slot_id" uuid,
	"table_topics_speaker_id" uuid,
	"role_label" text NOT NULL,
	"went_well" text,
	"try_next" text,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') NOT NULL,
	CONSTRAINT "role_feedback_notes_has_text" CHECK (coalesce(length("role_feedback_notes"."went_well"),0) + coalesce(length("role_feedback_notes"."try_next"),0) > 0),
	CONSTRAINT "role_feedback_notes_single_target" CHECK ("role_feedback_notes"."role_slot_id" is null or "role_feedback_notes"."table_topics_speaker_id" is null)
);
--> statement-breakpoint
ALTER TABLE "role_feedback_notes" ADD CONSTRAINT "role_feedback_notes_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_feedback_notes" ADD CONSTRAINT "role_feedback_notes_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_feedback_notes" ADD CONSTRAINT "role_feedback_notes_recipient_member_id_members_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_feedback_notes" ADD CONSTRAINT "role_feedback_notes_role_slot_id_role_slots_id_fk" FOREIGN KEY ("role_slot_id") REFERENCES "public"."role_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_feedback_notes" ADD CONSTRAINT "role_feedback_notes_tt_speaker_fk" FOREIGN KEY ("table_topics_speaker_id") REFERENCES "public"."table_topics_speakers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_feedback_notes_recipient_idx" ON "role_feedback_notes" USING btree ("recipient_member_id","created_at");--> statement-breakpoint
CREATE INDEX "role_feedback_notes_meeting_idx" ON "role_feedback_notes" USING btree ("meeting_id");