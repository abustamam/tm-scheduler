CREATE TABLE "dcp_goal_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scoreboard_id" uuid NOT NULL,
	"goal_key" text NOT NULL,
	"achieved" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dcp_scoreboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"program_year" integer NOT NULL,
	"base_member_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dcp_goal_progress" ADD CONSTRAINT "dcp_goal_progress_scoreboard_id_dcp_scoreboards_id_fk" FOREIGN KEY ("scoreboard_id") REFERENCES "public"."dcp_scoreboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dcp_goal_progress" ADD CONSTRAINT "dcp_goal_progress_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dcp_scoreboards" ADD CONSTRAINT "dcp_scoreboards_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dcp_goal_progress_scoreboard_goal_unique" ON "dcp_goal_progress" USING btree ("scoreboard_id","goal_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dcp_scoreboards_club_year_unique" ON "dcp_scoreboards" USING btree ("club_id","program_year");