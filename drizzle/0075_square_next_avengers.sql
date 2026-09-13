ALTER TYPE "public"."activity_action" ADD VALUE 'vote_disqualify' BEFORE 'plan_set';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'vote_disqualify_undo' BEFORE 'plan_set';--> statement-breakpoint
CREATE TABLE "meeting_candidate_disqualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"category" "award_category" NOT NULL,
	"candidate_member_id" uuid,
	"candidate_guest_id" uuid,
	"candidate_write_in" text,
	"reason" text NOT NULL,
	"disqualified_by_member_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_candidate_dq_single_candidate" CHECK (num_nonnulls("meeting_candidate_disqualifications"."candidate_member_id", "meeting_candidate_disqualifications"."candidate_guest_id", "meeting_candidate_disqualifications"."candidate_write_in") = 1)
);
--> statement-breakpoint
ALTER TABLE "meeting_candidate_disqualifications" ADD CONSTRAINT "meeting_candidate_disqualifications_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidate_disqualifications" ADD CONSTRAINT "meeting_candidate_disqualifications_candidate_member_id_members_id_fk" FOREIGN KEY ("candidate_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidate_disqualifications" ADD CONSTRAINT "meeting_candidate_disqualifications_candidate_guest_id_guests_id_fk" FOREIGN KEY ("candidate_guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_candidate_disqualifications" ADD CONSTRAINT "meeting_candidate_disqualifications_disqualified_by_member_id_members_id_fk" FOREIGN KEY ("disqualified_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_candidate_disqualifications_meeting_idx" ON "meeting_candidate_disqualifications" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_candidate_dq_member_unique" ON "meeting_candidate_disqualifications" USING btree ("meeting_id","category","candidate_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_candidate_dq_guest_unique" ON "meeting_candidate_disqualifications" USING btree ("meeting_id","category","candidate_guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_candidate_dq_write_in_unique" ON "meeting_candidate_disqualifications" USING btree ("meeting_id","category","candidate_write_in");