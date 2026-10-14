CREATE TYPE "public"."mentorship_request_status" AS ENUM('pending', 'accepted', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TABLE "mentorship_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"mentee_member_id" uuid NOT NULL,
	"mentor_member_id" uuid NOT NULL,
	"focus" "mentorship_focus" DEFAULT 'new_member' NOT NULL,
	"focus_other" text,
	"status" "mentorship_request_status" DEFAULT 'pending' NOT NULL,
	"mentorship_id" uuid,
	"decided_by_member_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	CONSTRAINT "mentorship_requests_not_self_check" CHECK ("mentorship_requests"."mentee_member_id" <> "mentorship_requests"."mentor_member_id"),
	CONSTRAINT "mentorship_requests_focus_other_check" CHECK ("mentorship_requests"."focus_other" is null or "mentorship_requests"."focus" = 'other')
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "mentor_bio" text;--> statement-breakpoint
ALTER TABLE "mentorship_requests" ADD CONSTRAINT "mentorship_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_requests" ADD CONSTRAINT "mentorship_requests_mentee_member_id_members_id_fk" FOREIGN KEY ("mentee_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_requests" ADD CONSTRAINT "mentorship_requests_mentor_member_id_members_id_fk" FOREIGN KEY ("mentor_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_requests" ADD CONSTRAINT "mentorship_requests_mentorship_id_mentorships_id_fk" FOREIGN KEY ("mentorship_id") REFERENCES "public"."mentorships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_requests" ADD CONSTRAINT "mentorship_requests_decided_by_member_id_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentorship_requests_club_idx" ON "mentorship_requests" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "mentorship_requests_mentor_idx" ON "mentorship_requests" USING btree ("mentor_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentorship_requests_one_pending_unique" ON "mentorship_requests" USING btree ("mentee_member_id") WHERE "mentorship_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_mentor_bio_len_check" CHECK ("members"."mentor_bio" is null or char_length("members"."mentor_bio") between 1 and 500);