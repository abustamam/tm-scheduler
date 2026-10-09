-- #1125 / ADR-0031: a guest's email and phone live on their Person.
--
-- `guests.person_id` (#1124) points every guest at a `people` row; this moves the
-- contact onto it and makes the pointer NOT NULL. The columns `guests.email` and
-- `guests.phone` are KEPT in the database, dead, for one release: they are no
-- longer declared in `schema.ts` (so no code can read or write them), but the old
-- container is still serving while this runs and must never read a dropped column.
-- #1126 drops them in SQL, and its migration catches up whatever the old container
-- wrote to them after the copy below, before it drops them.
-- `bun run db:generate` emits `DROP COLUMN` for both because the schema no longer
-- names them; those two statements are deliberately edited out of this file (the
-- snapshot still records them as gone, so the generate stays clean).
--
-- Forward repair only: no down migration, and reverting the CODE is not a clean
-- undo: a contact edited after this deploy lives on `people` and needs a forward
-- copy back. `guests_contact_backup` is a forensic copy, not a restore path
-- (precedent: #1089).
--
-- 0. LOCK `guests` FIRST, for the reason 0107 gives: drizzle runs every pending
--    migration in ONE transaction at READ COMMITTED and the old container keeps
--    serving. Holding it from the start means no guest row can be inserted
--    without a Person between step 1 and the NOT NULL below (which would fail
--    the whole deploy), and the backup and the copy read one set of rows.
--    `scripts/migrate.ts` bounds the wait for it.
-- 1. Re-backfill, by #1124's rule: a converted guest takes its membership's
--    Person, every other guest gets its own fresh name-only Person. Only guests
--    the old container wrote WITHOUT a Person during #1124's deploy swap match.
-- 2. Snapshot every guest contact (with its club and Person), one row per guest
--    that had either field.
-- 3. Copy the contact onto the guest's Person, and ONLY where the Person is
--    guest-only AND never was a member: nobody has signed in as it, it holds no
--    membership, it carries none of the roster-identity columns (`customer_id`,
--    `basecamp_user_id`, `original_join_date`, `invited_at`) and no `member_remove`
--    names it. That is `unboundGuestOnlyPerson()` plus `noMemberHistory()` in
--    `account-link-logic.ts`, the arms `guestContactFillable` carries: a removed
--    member's Person holds no membership, so it reads guest-only, but its contact
--    is the member's and a roster re-import re-attaches it (#875). And only into a
--    NULL field. A guest-only Person normally has one guest row; if a superadmin
--    merge gave one two, the OLDEST guest row that has the field wins, so the
--    result is deterministic.
-- 4. NOT NULL.
--
-- `src/server/guest-contact-migration.integration.test.ts` runs the real drizzle
-- runner through this file on a scratch database, so a regenerated file that lost
-- a statement or an arm fails there. `bun run db:generate` reproduces only the
-- CREATE TABLE and the NOT NULL.
LOCK TABLE "guests" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
-- `person_id IS NULL`: step 1 only ever FILLS. It can never move a pointer that
-- something else already set, and the same holds for the UPDATE after the insert.
UPDATE "guests" g SET "person_id" = m."person_id"
	FROM "members" m
	WHERE m."id" = g."converted_membership_id" AND g."person_id" IS NULL;--> statement-breakpoint
CREATE TEMP TABLE "guest_person_map_1125" AS
	SELECT "id" AS "guest_id", gen_random_uuid() AS "person_id"
	FROM "guests" WHERE "person_id" IS NULL;--> statement-breakpoint
INSERT INTO "people" ("id", "name", "preferred_name", "created_at")
	SELECT m."person_id", g."name", g."preferred_name", g."created_at"
	FROM "guest_person_map_1125" m JOIN "guests" g ON g."id" = m."guest_id";--> statement-breakpoint
UPDATE "guests" g SET "person_id" = m."person_id"
	FROM "guest_person_map_1125" m WHERE m."guest_id" = g."id";--> statement-breakpoint
-- A temp table lives as long as its pooled session, not this migration.
DROP TABLE "guest_person_map_1125";--> statement-breakpoint
CREATE TABLE "guests_contact_backup" (
	"guest_id" uuid PRIMARY KEY NOT NULL,
	"club_id" uuid,
	"person_id" uuid,
	"email" text,
	"phone" text,
	"snapshot_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "guests_contact_backup" ("guest_id", "club_id", "person_id", "email", "phone")
	SELECT "id", "club_id", "person_id", "email", "phone"
	FROM "guests" WHERE "email" IS NOT NULL OR "phone" IS NOT NULL
	ON CONFLICT ("guest_id") DO NOTHING;--> statement-breakpoint
UPDATE "people" p SET "email" = src."email"
	FROM (
		SELECT DISTINCT ON (g."person_id") g."person_id", g."email"
		FROM "guests" g
		WHERE g."email" IS NOT NULL
		ORDER BY g."person_id", g."created_at", g."id"
	) src
	WHERE src."person_id" = p."id"
		AND p."email" IS NULL
		AND p."user_id" IS NULL
		AND NOT EXISTS (SELECT 1 FROM "members" m WHERE m."person_id" = p."id")
		AND p."customer_id" IS NULL
		AND p."basecamp_user_id" IS NULL
		AND p."original_join_date" IS NULL
		AND p."invited_at" IS NULL
		AND NOT EXISTS (
			SELECT 1 FROM "activity_log" a
			WHERE a."action" = 'member_remove' AND a."detail" ->> 'personId' = p."id"::text
		);--> statement-breakpoint
UPDATE "people" p SET "phone" = src."phone"
	FROM (
		SELECT DISTINCT ON (g."person_id") g."person_id", g."phone"
		FROM "guests" g
		WHERE g."phone" IS NOT NULL
		ORDER BY g."person_id", g."created_at", g."id"
	) src
	WHERE src."person_id" = p."id"
		AND p."phone" IS NULL
		AND p."user_id" IS NULL
		AND NOT EXISTS (SELECT 1 FROM "members" m WHERE m."person_id" = p."id")
		AND p."customer_id" IS NULL
		AND p."basecamp_user_id" IS NULL
		AND p."original_join_date" IS NULL
		AND p."invited_at" IS NULL
		AND NOT EXISTS (
			SELECT 1 FROM "activity_log" a
			WHERE a."action" = 'member_remove' AND a."detail" ->> 'personId' = p."id"::text
		);--> statement-breakpoint
ALTER TABLE "guests" ALTER COLUMN "person_id" SET NOT NULL;
