ALTER TYPE "public"."activity_action" ADD VALUE 'superadmin_acted';--> statement-breakpoint
ALTER TYPE "public"."impersonation_mode" ADD VALUE 'read_write';--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_impersonated_by_user_id_fk" FOREIGN KEY ("impersonated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;