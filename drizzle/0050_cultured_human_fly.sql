CREATE TABLE "project_completion_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"marked_by_member_id" uuid,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_completion_marks" ADD CONSTRAINT "project_completion_marks_enrollment_id_path_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."path_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_completion_marks" ADD CONSTRAINT "project_completion_marks_project_id_pathways_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pathways_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_completion_marks" ADD CONSTRAINT "project_completion_marks_marked_by_member_id_members_id_fk" FOREIGN KEY ("marked_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_completion_marks_enrollment_project_idx" ON "project_completion_marks" USING btree ("enrollment_id","project_id");