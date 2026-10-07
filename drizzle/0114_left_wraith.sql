CREATE TYPE "public"."contact_preference_source" AS ENUM('member', 'officer');--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "contact_preference_by" "contact_preference_source";--> statement-breakpoint
UPDATE "people" SET "contact_preference_by" =
  CASE WHEN "user_id" IS NOT NULL THEN 'member'::contact_preference_source
       ELSE 'officer'::contact_preference_source END
WHERE "preferred_contact" IS NOT NULL;
