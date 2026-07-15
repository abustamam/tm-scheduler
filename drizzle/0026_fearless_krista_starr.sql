CREATE TYPE "public"."dues_status" AS ENUM('paid', 'waived');--> statement-breakpoint
CREATE TABLE "dues_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"label" text NOT NULL,
	"due_date" timestamp NOT NULL,
	"default_amount_cents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_dues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"dues_period_id" uuid NOT NULL,
	"status" "dues_status" NOT NULL,
	"amount_cents" integer,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dues_periods" ADD CONSTRAINT "dues_periods_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_dues" ADD CONSTRAINT "member_dues_membership_id_members_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_dues" ADD CONSTRAINT "member_dues_dues_period_id_dues_periods_id_fk" FOREIGN KEY ("dues_period_id") REFERENCES "public"."dues_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dues_periods_club_idx" ON "dues_periods" USING btree ("club_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "member_dues_membership_period_unique" ON "member_dues" USING btree ("membership_id","dues_period_id");--> statement-breakpoint
CREATE INDEX "member_dues_period_idx" ON "member_dues" USING btree ("dues_period_id");