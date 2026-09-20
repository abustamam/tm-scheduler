CREATE TABLE "mcp_pending_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"payload" jsonb,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"applied_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "mcp_pending_plans" ADD CONSTRAINT "mcp_pending_plans_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_plans" ADD CONSTRAINT "mcp_pending_plans_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_pending_plans_sweep_idx" ON "mcp_pending_plans" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_pending_plans_club_idx" ON "mcp_pending_plans" USING btree ("club_id");--> statement-breakpoint
-- HAND-WRITTEN, and the reason is in-flight rows (#812). `drizzle-kit generate`
-- emitted CREATE TABLE + DROP TABLE, which is correct about the SHAPE and loses
-- every pending plan. A confirm link lives for up to 48 hours and migrations
-- apply at container startup with no drain, so a deploy landing mid-window
-- would break every link a member had already been handed. The id is carried
-- over unchanged, so those links keep working.
--
-- `meeting_date` becomes `payload.meetingDate`: one table now serves every MCP
-- write tool, and a date column that is NOT NULL for one and meaningless for a
-- tool carrying many is two tables wearing one name. `to_char` because the
-- column is a `date` and the payload holds the club-local `YYYY-MM-DD` string
-- the planner takes, with no timezone in the middle.
--
-- `jsonb_build_object` renders a SQL NULL `entries` as JSON `null`, which is
-- exactly the applied tombstone's shape — so an already-applied row migrates to
-- `{"meetingDate": "...", "entries": null}` and keeps saying what it said.
--
-- To reverse: recreate `guest_book_pending_plans` per migration 0081 + 0082,
-- then INSERT ... SELECT back, reading `payload->>'meetingDate'` as the date and
-- `payload->'entries'` as the entries. The move is additive within the jsonb, so
-- nothing is lost in either direction. Drop the table rather than leaving it
-- populated: reverting the application code removes everything that deletes
-- these rows, and they hold visitors' names, emails and phone numbers.
INSERT INTO "mcp_pending_plans" ("id", "club_id", "tool", "payload", "created_by_user_id", "created_at", "expires_at", "applied_at")
SELECT
	"id",
	"club_id",
	'record_guest_book',
	jsonb_build_object(
		'meetingDate', to_char("meeting_date", 'YYYY-MM-DD'),
		'entries', "entries"
	),
	"created_by_user_id",
	"created_at",
	"expires_at",
	"applied_at"
FROM "guest_book_pending_plans";--> statement-breakpoint
DROP TABLE "guest_book_pending_plans" CASCADE;
