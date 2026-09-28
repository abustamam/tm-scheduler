CREATE TYPE "public"."club_charter_status" AS ENUM('chartering', 'chartered');--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "charter_status" "club_charter_status";--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "charter_status" "club_charter_status" DEFAULT 'chartered' NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "chartered_at" date;