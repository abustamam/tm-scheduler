CREATE TYPE "public"."attendance_plan_status" AS ENUM('reached_out', 'coming', 'not_coming');--> statement-breakpoint
-- `plan_set` must never be referenced by migration SQL, only by runtime code.
-- drizzle applies ALL pending migrations inside ONE transaction, and Postgres
-- refuses to USE an enum value added by an `ALTER TYPE` that has not committed.
-- On prod this migration is long since committed so such a reference would
-- succeed, but on any FRESH database — CI, a new Railway environment, a preview
-- env — 0060 is still pending in the same transaction and it would fail with
-- `unsafe use of new value "plan_set"`. That is a green-locally, red-on-CI trap.
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