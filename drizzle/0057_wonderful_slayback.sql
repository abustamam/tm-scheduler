CREATE TYPE "public"."action_item_resolution" AS ENUM('done', 'dropped');--> statement-breakpoint
CREATE TABLE "club_action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"text" text NOT NULL,
	"owner_member_id" uuid,
	"due_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" "action_item_resolution",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_action_items_resolution_paired" CHECK (("club_action_items"."resolved_at" is null) = ("club_action_items"."resolution" is null))
);
--> statement-breakpoint
ALTER TABLE "club_action_items" ADD CONSTRAINT "club_action_items_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_action_items" ADD CONSTRAINT "club_action_items_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_action_items_club_idx" ON "club_action_items" USING btree ("club_id","created_at");