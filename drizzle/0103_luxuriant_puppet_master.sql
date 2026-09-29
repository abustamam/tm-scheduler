-- Mentorship (#939): member-to-member pairings inside a club, and the member's
-- own "willing to mentor" flag. As generated, NOT hand-edited.
--
-- willing_to_mentor is ONE statement, ADD COLUMN ... DEFAULT false NOT NULL, on
-- purpose: that backfills every existing membership with false, which is exactly
-- the intended state (nobody has volunteered yet). This is NOT 0102's now() trap,
-- where the backfill put every veteran into orientation. Do not split it.
CREATE TYPE "public"."mentorship_focus" AS ENUM('new_member', 'contest', 'leadership', 'other');--> statement-breakpoint
CREATE TABLE "mentorships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"mentor_member_id" uuid NOT NULL,
	"mentee_member_id" uuid NOT NULL,
	"focus" "mentorship_focus",
	"focus_other" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"created_by_member_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mentorships_not_self_check" CHECK ("mentorships"."mentor_member_id" <> "mentorships"."mentee_member_id"),
	CONSTRAINT "mentorships_focus_other_check" CHECK ("mentorships"."focus_other" is null or "mentorships"."focus" = 'other')
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "willing_to_mentor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mentorships" ADD CONSTRAINT "mentorships_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorships" ADD CONSTRAINT "mentorships_mentor_member_id_members_id_fk" FOREIGN KEY ("mentor_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorships" ADD CONSTRAINT "mentorships_mentee_member_id_members_id_fk" FOREIGN KEY ("mentee_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorships" ADD CONSTRAINT "mentorships_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentorships_club_idx" ON "mentorships" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "mentorships_mentor_idx" ON "mentorships" USING btree ("mentor_member_id");--> statement-breakpoint
CREATE INDEX "mentorships_mentee_idx" ON "mentorships" USING btree ("mentee_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentorships_active_focus_unique" ON "mentorships" USING btree ("mentor_member_id","mentee_member_id","focus") WHERE "mentorships"."ended_at" is null and "mentorships"."focus" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mentorships_active_nofocus_unique" ON "mentorships" USING btree ("mentor_member_id","mentee_member_id") WHERE "mentorships"."ended_at" is null and "mentorships"."focus" is null;