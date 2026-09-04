CREATE TABLE "officer_training_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"program_year" integer NOT NULL,
	"period" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "officer_training_periods_period_check" CHECK ("officer_training_periods"."period" in (1, 2)),
	CONSTRAINT "officer_training_periods_order_check" CHECK ("officer_training_periods"."ends_on" >= "officer_training_periods"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "officer_training_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"position" "officer_position" NOT NULL,
	"program_year" integer NOT NULL,
	"period" integer NOT NULL,
	"trained_on" date,
	"recorded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "officer_training_records_period_check" CHECK ("officer_training_records"."period" in (1, 2))
);
--> statement-breakpoint
ALTER TABLE "officer_training_periods" ADD CONSTRAINT "officer_training_periods_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "officer_training_records" ADD CONSTRAINT "officer_training_records_membership_id_members_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "officer_training_records" ADD CONSTRAINT "officer_training_records_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "officer_training_periods_club_year_period_unique" ON "officer_training_periods" USING btree ("club_id","program_year","period");--> statement-breakpoint
CREATE UNIQUE INDEX "officer_training_records_unique" ON "officer_training_records" USING btree ("membership_id","position","program_year","period");