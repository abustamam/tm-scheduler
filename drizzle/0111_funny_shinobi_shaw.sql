CREATE TYPE "public"."contact_method" AS ENUM('email', 'call', 'sms', 'whatsapp');--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "preferred_contact" "contact_method";