CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "public"."award_category" AS ENUM('best_speaker', 'best_evaluator', 'best_table_topics');--> statement-breakpoint
CREATE TABLE "meeting_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"member_id" uuid,
	"guest_id" uuid,
	"status" "attendance_status" DEFAULT 'absent' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_attendance_single_assignee" CHECK ("meeting_attendance"."member_id" is null or "meeting_attendance"."guest_id" is null)
);
--> statement-breakpoint
CREATE TABLE "meeting_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"category" "award_category" NOT NULL,
	"member_id" uuid,
	"guest_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_awards_single_assignee" CHECK ("meeting_awards"."member_id" is null or "meeting_awards"."guest_id" is null)
);
--> statement-breakpoint
CREATE TABLE "table_topics_speakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"member_id" uuid,
	"guest_id" uuid,
	"topic" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "table_topics_speakers_single_assignee" CHECK ("table_topics_speakers"."member_id" is null or "table_topics_speakers"."guest_id" is null)
);
--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_awards" ADD CONSTRAINT "meeting_awards_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_awards" ADD CONSTRAINT "meeting_awards_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_awards" ADD CONSTRAINT "meeting_awards_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_topics_speakers" ADD CONSTRAINT "table_topics_speakers_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_topics_speakers" ADD CONSTRAINT "table_topics_speakers_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_topics_speakers" ADD CONSTRAINT "table_topics_speakers_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_attendance_meeting_idx" ON "meeting_attendance" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_member_unique" ON "meeting_attendance" USING btree ("meeting_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_guest_unique" ON "meeting_attendance" USING btree ("meeting_id","guest_id");--> statement-breakpoint
CREATE INDEX "meeting_awards_meeting_idx" ON "meeting_awards" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_awards_meeting_category_unique" ON "meeting_awards" USING btree ("meeting_id","category");--> statement-breakpoint
CREATE INDEX "table_topics_speakers_meeting_idx" ON "table_topics_speakers" USING btree ("meeting_id");