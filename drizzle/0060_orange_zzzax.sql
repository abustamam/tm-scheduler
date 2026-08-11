CREATE TYPE "public"."attendance_plan_status" AS ENUM('reached_out', 'coming', 'not_coming');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'plan_set';--> statement-breakpoint
CREATE TABLE "meeting_attendance_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"status" "attendance_plan_status" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_attendance_plan" ADD CONSTRAINT "meeting_attendance_plan_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance_plan" ADD CONSTRAINT "meeting_attendance_plan_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_plan_unique" ON "meeting_attendance_plan" USING btree ("member_id","meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_attendance_plan_meeting_idx" ON "meeting_attendance_plan" USING btree ("meeting_id");