CREATE TYPE "public"."cover_request_kind" AS ENUM('finding_cover', 'dropped');--> statement-breakpoint
CREATE TABLE "slot_cover_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"released_by_member_id" uuid,
	"kind" "cover_request_kind" NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"covered_by_member_id" uuid,
	"covered_guest_id" uuid,
	"covered_at" timestamp with time zone,
	"prior_status" "slot_status" NOT NULL,
	"prior_claimed_at" timestamp,
	"prior_speech_id" uuid
);
--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_slot_id_role_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."role_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_released_by_member_id_members_id_fk" FOREIGN KEY ("released_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_covered_by_member_id_members_id_fk" FOREIGN KEY ("covered_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_covered_guest_id_guests_id_fk" FOREIGN KEY ("covered_guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_cover_requests" ADD CONSTRAINT "slot_cover_requests_prior_speech_id_speeches_id_fk" FOREIGN KEY ("prior_speech_id") REFERENCES "public"."speeches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slot_cover_requests_open_uq" ON "slot_cover_requests" USING btree ("slot_id") WHERE "slot_cover_requests"."covered_at" is null;--> statement-breakpoint
CREATE INDEX "slot_cover_requests_meeting_idx" ON "slot_cover_requests" USING btree ("meeting_id");