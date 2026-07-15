CREATE TYPE "public"."impersonation_mode" AS ENUM('read_only');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'superadmin_viewed';--> statement-breakpoint
CREATE TABLE "impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"superadmin_user_id" text NOT NULL,
	"club_id" uuid NOT NULL,
	"mode" "impersonation_mode" DEFAULT 'read_only' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_superadmin_user_id_user_id_fk" FOREIGN KEY ("superadmin_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "impersonation_sessions_superadmin_idx" ON "impersonation_sessions" USING btree ("superadmin_user_id");