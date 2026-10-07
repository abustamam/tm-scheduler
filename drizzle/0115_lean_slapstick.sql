CREATE TABLE "area_clubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"club_id" uuid,
	"name" text NOT NULL,
	"club_number" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "area_directors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"assigned_by" text,
	"ended_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "area_directors_term_order_check" CHECK ("area_directors"."ended_at" is null or "area_directors"."ended_at" >= "area_directors"."started_at")
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"division_id" uuid NOT NULL,
	"number" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_club_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"visited_on" date NOT NULL,
	"recorded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "club_visits_round_check" CHECK ("club_visits"."round" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "districts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "districts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "divisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"district_id" uuid NOT NULL,
	"program_year" integer NOT NULL,
	"letter" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "area_clubs" ADD CONSTRAINT "area_clubs_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_clubs" ADD CONSTRAINT "area_clubs_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_directors" ADD CONSTRAINT "area_directors_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_directors" ADD CONSTRAINT "area_directors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_directors" ADD CONSTRAINT "area_directors_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_directors" ADD CONSTRAINT "area_directors_ended_by_user_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_visits" ADD CONSTRAINT "club_visits_area_club_id_area_clubs_id_fk" FOREIGN KEY ("area_club_id") REFERENCES "public"."area_clubs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_visits" ADD CONSTRAINT "club_visits_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "area_clubs_area_club_unique" ON "area_clubs" USING btree ("area_id","club_id") WHERE "area_clubs"."club_id" is not null;--> statement-breakpoint
CREATE INDEX "area_clubs_club_idx" ON "area_clubs" USING btree ("club_id");--> statement-breakpoint
CREATE UNIQUE INDEX "area_directors_open_unique" ON "area_directors" USING btree ("area_id") WHERE "area_directors"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "area_directors_user_open_idx" ON "area_directors" USING btree ("user_id") WHERE "area_directors"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "areas_division_number_unique" ON "areas" USING btree ("division_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "club_visits_area_club_round_unique" ON "club_visits" USING btree ("area_club_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "divisions_district_year_letter_unique" ON "divisions" USING btree ("district_id","program_year","letter");