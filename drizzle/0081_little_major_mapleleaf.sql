CREATE TABLE "guest_book_pending_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"meeting_date" date NOT NULL,
	"created_by_user_id" text NOT NULL,
	"entries" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"applied_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "guest_book_pending_plans" ADD CONSTRAINT "guest_book_pending_plans_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_book_pending_plans" ADD CONSTRAINT "guest_book_pending_plans_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_book_pending_plans_sweep_idx" ON "guest_book_pending_plans" USING btree ("expires_at");