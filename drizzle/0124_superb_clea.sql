ALTER TYPE "public"."membership_status" ADD VALUE 'former';--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "ended_at" date;