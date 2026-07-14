CREATE TYPE "public"."guest_stage" AS ENUM('prospect', 'following_up', 'joined', 'lost');--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "stage" "guest_stage" DEFAULT 'prospect' NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "converted_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_converted_membership_id_members_id_fk" FOREIGN KEY ("converted_membership_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;