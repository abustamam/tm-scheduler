CREATE TYPE "public"."speech_request_status" AS ENUM('open', 'scheduled', 'withdrawn');--> statement-breakpoint
CREATE TABLE "speech_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"title" text,
	"path" text,
	"project_id" uuid,
	"project_name" text,
	"introduction" text,
	"preferred_dates" date[] DEFAULT '{}'::date[] NOT NULL,
	"status" "speech_request_status" DEFAULT 'open' NOT NULL,
	"scheduled_slot_id" uuid,
	"speech_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speech_requests_max_three_dates" CHECK (cardinality("speech_requests"."preferred_dates") <= 3)
);
--> statement-breakpoint
ALTER TABLE "speech_requests" ADD CONSTRAINT "speech_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_requests" ADD CONSTRAINT "speech_requests_membership_id_members_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_requests" ADD CONSTRAINT "speech_requests_project_id_pathways_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pathways_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_requests" ADD CONSTRAINT "speech_requests_scheduled_slot_id_role_slots_id_fk" FOREIGN KEY ("scheduled_slot_id") REFERENCES "public"."role_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_requests" ADD CONSTRAINT "speech_requests_speech_id_speeches_id_fk" FOREIGN KEY ("speech_id") REFERENCES "public"."speeches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speech_requests_club_status_idx" ON "speech_requests" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "speech_requests_membership_idx" ON "speech_requests" USING btree ("membership_id");