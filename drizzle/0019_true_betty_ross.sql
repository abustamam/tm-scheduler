CREATE TABLE "bcm_project_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"complete" boolean NOT NULL,
	"speech_title" text,
	"speech_date" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pathways_path_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"min_req_electives" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pathways_projects" ADD COLUMN "bcm_block_id" text;--> statement-breakpoint
ALTER TABLE "bcm_project_progress" ADD CONSTRAINT "bcm_project_progress_enrollment_id_path_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."path_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bcm_project_progress" ADD CONSTRAINT "bcm_project_progress_project_id_pathways_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pathways_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pathways_path_levels" ADD CONSTRAINT "pathways_path_levels_path_id_pathways_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."pathways_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bcm_project_progress_enrollment_project_idx" ON "bcm_project_progress" USING btree ("enrollment_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pathways_path_levels_path_level_idx" ON "pathways_path_levels" USING btree ("path_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX "pathways_projects_bcm_block_id_idx" ON "pathways_projects" USING btree ("bcm_block_id") WHERE "pathways_projects"."bcm_block_id" is not null;