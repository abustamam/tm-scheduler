-- #1124 / ADR-0031: a guest is a Person. Every guest row gets a `people` row.
--
-- Forward repair only: no down migration. Reverting the code leaves `person_id`
-- populated and unread; the column is nullable until #1125 sets NOT NULL.
ALTER TABLE "guests" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guests_person_idx" ON "guests" USING btree ("person_id");--> statement-breakpoint
-- Converted guests already ARE a member's Person. A STRANDED guest (`joined`,
-- membership removed, pointer null) matches no member row and is handled with
-- the unconverted ones below.
UPDATE "guests" g SET "person_id" = m."person_id"
	FROM "members" m WHERE m."id" = g."converted_membership_id";--> statement-breakpoint
-- Everyone else gets their own fresh Person. Name only: contact moves in #1125.
-- The backfill does no cross-row merging (ADR-0008 forbids merging on name, and
-- the public guest book never links across clubs).
CREATE TEMP TABLE "guest_person_map" AS
	SELECT "id" AS "guest_id", gen_random_uuid() AS "person_id"
	FROM "guests" WHERE "person_id" IS NULL;--> statement-breakpoint
INSERT INTO "people" ("id", "name", "preferred_name", "created_at")
	SELECT m."person_id", g."name", g."preferred_name", g."created_at"
	FROM "guest_person_map" m JOIN "guests" g ON g."id" = m."guest_id";--> statement-breakpoint
UPDATE "guests" g SET "person_id" = m."person_id"
	FROM "guest_person_map" m WHERE m."guest_id" = g."id";--> statement-breakpoint
-- A temp table lives as long as its pooled session, not this migration.
DROP TABLE "guest_person_map";
