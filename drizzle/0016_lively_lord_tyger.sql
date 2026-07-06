CREATE TYPE "public"."pathway_status" AS ENUM('current', 'legacy');--> statement-breakpoint
CREATE TABLE "path_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"path_id" uuid NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "path_level_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"completed" integer NOT NULL,
	"total" integer NOT NULL,
	"approved" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pathways_paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_code" text NOT NULL,
	"name" text NOT NULL,
	"status" "pathway_status" DEFAULT 'current' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pathways_paths_course_code_unique" UNIQUE("course_code")
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "basecamp_user_id" text;--> statement-breakpoint
ALTER TABLE "path_enrollments" ADD CONSTRAINT "path_enrollments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_enrollments" ADD CONSTRAINT "path_enrollments_path_id_pathways_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."pathways_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_level_progress" ADD CONSTRAINT "path_level_progress_enrollment_id_path_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."path_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "path_enrollments_person_path_idx" ON "path_enrollments" USING btree ("person_id","path_id");--> statement-breakpoint
CREATE UNIQUE INDEX "path_level_progress_enrollment_level_idx" ON "path_level_progress" USING btree ("enrollment_id","level");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_basecamp_user_id_unique" UNIQUE("basecamp_user_id");