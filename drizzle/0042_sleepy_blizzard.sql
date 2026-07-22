ALTER TYPE "public"."activity_action" ADD VALUE 'outreach_set';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'outreach_clear';--> statement-breakpoint
CREATE TABLE "meeting_outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_outreach" ADD CONSTRAINT "meeting_outreach_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_outreach" ADD CONSTRAINT "meeting_outreach_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_outreach_unique" ON "meeting_outreach" USING btree ("member_id","meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_outreach_meeting_idx" ON "meeting_outreach" USING btree ("meeting_id");