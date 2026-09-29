CREATE TYPE "public"."charter_helper_role" AS ENUM('sponsor', 'club_mentor');--> statement-breakpoint
CREATE TABLE "club_charter" (
	"club_id" uuid PRIMARY KEY NOT NULL,
	"members_needed" integer DEFAULT 20 NOT NULL,
	"dues_period_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "club_charter_members_needed_check" CHECK ("club_charter"."members_needed" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "club_charter_helpers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"role" charter_helper_role NOT NULL,
	"person_id" uuid,
	"name" text,
	"email" text,
	"phone" text,
	"home_club" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "club_charter_helpers_identity_check" CHECK ("club_charter_helpers"."person_id" is not null or ("club_charter_helpers"."name" is not null and btrim("club_charter_helpers"."name") <> ''))
);
--> statement-breakpoint
CREATE TABLE "club_charter_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"done_at" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_charter" ADD CONSTRAINT "club_charter_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charter" ADD CONSTRAINT "club_charter_dues_period_id_dues_periods_id_fk" FOREIGN KEY ("dues_period_id") REFERENCES "public"."dues_periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charter_helpers" ADD CONSTRAINT "club_charter_helpers_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charter_helpers" ADD CONSTRAINT "club_charter_helpers_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charter_steps" ADD CONSTRAINT "club_charter_steps_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_charter_helpers_club_idx" ON "club_charter_helpers" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "club_charter_steps_club_idx" ON "club_charter_steps" USING btree ("club_id","position");