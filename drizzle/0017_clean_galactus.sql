CREATE TABLE "pathways_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"name" text NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "speeches" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "pathways_projects" ADD CONSTRAINT "pathways_projects_path_id_pathways_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."pathways_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pathways_projects_path_level_name_idx" ON "pathways_projects" USING btree ("path_id","level","name");--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_project_id_pathways_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pathways_projects"("id") ON DELETE set null ON UPDATE no action;