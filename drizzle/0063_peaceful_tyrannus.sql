ALTER TABLE "meeting_awards" DROP CONSTRAINT "meeting_awards_single_assignee";--> statement-breakpoint
ALTER TABLE "meeting_votes" DROP CONSTRAINT "meeting_votes_single_candidate";--> statement-breakpoint
ALTER TABLE "meeting_awards" ADD COLUMN "write_in_name" text;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD COLUMN "candidate_write_in" text;--> statement-breakpoint
ALTER TABLE "meeting_awards" ADD CONSTRAINT "meeting_awards_single_assignee" CHECK (num_nonnulls("meeting_awards"."member_id", "meeting_awards"."guest_id", "meeting_awards"."write_in_name") <= 1);--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_single_candidate" CHECK (num_nonnulls("meeting_votes"."candidate_member_id", "meeting_votes"."candidate_guest_id", "meeting_votes"."candidate_write_in") <= 1);