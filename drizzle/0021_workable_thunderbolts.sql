CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_slots" ADD COLUMN "assigned_guest_id" uuid;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guests_club_idx" ON "guests" USING btree ("club_id");--> statement-breakpoint
ALTER TABLE "role_slots" ADD CONSTRAINT "role_slots_assigned_guest_id_guests_id_fk" FOREIGN KEY ("assigned_guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_slots_assigned_guest_idx" ON "role_slots" USING btree ("assigned_guest_id");--> statement-breakpoint
ALTER TABLE "role_slots" ADD CONSTRAINT "role_slots_single_assignee" CHECK ("role_slots"."assigned_member_id" is null or "role_slots"."assigned_guest_id" is null);