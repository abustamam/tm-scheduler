ALTER TYPE "public"."activity_action" ADD VALUE 'vote_open';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'vote_close';--> statement-breakpoint
CREATE TABLE "meeting_vote_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"category" "award_category" NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"opened_by_member_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"voter_member_id" uuid,
	"voter_guest_id" uuid,
	"candidate_member_id" uuid,
	"candidate_guest_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_votes_single_voter" CHECK ("meeting_votes"."voter_member_id" is null or "meeting_votes"."voter_guest_id" is null),
	CONSTRAINT "meeting_votes_single_candidate" CHECK ("meeting_votes"."candidate_member_id" is null or "meeting_votes"."candidate_guest_id" is null)
);
--> statement-breakpoint
ALTER TABLE "meeting_vote_sessions" ADD CONSTRAINT "meeting_vote_sessions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_vote_sessions" ADD CONSTRAINT "meeting_vote_sessions_opened_by_member_id_members_id_fk" FOREIGN KEY ("opened_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_session_id_meeting_vote_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_vote_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_voter_member_id_members_id_fk" FOREIGN KEY ("voter_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_voter_guest_id_guests_id_fk" FOREIGN KEY ("voter_guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_candidate_member_id_members_id_fk" FOREIGN KEY ("candidate_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_candidate_guest_id_guests_id_fk" FOREIGN KEY ("candidate_guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_vote_sessions_meeting_idx" ON "meeting_vote_sessions" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_vote_sessions_meeting_category_unique" ON "meeting_vote_sessions" USING btree ("meeting_id","category");--> statement-breakpoint
CREATE INDEX "meeting_votes_session_idx" ON "meeting_votes" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_votes_voter_member_unique" ON "meeting_votes" USING btree ("session_id","voter_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_votes_voter_guest_unique" ON "meeting_votes" USING btree ("session_id","voter_guest_id");