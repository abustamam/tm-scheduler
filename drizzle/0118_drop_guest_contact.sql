-- #1126 / ADR-0031: drop `guests.email` and `guests.phone`.
--
-- #1125 (0117) moved a guest's contact onto their Person and left these two
-- columns in the database, dead and undeclared in `schema.ts`, so the container
-- that was still serving during that deploy swap never read a dropped column.
-- That container is gone, so this drops them. `db:generate` cannot write this
-- file: `schema.ts` and the 0117 snapshot already omit the columns, so it sees
-- nothing to change. It is a custom migration.
--
-- Forward repair only: no down migration. The values live on `people` and, as of
-- 0117, in `guests_contact_backup` (a forensic copy, not a restore path;
-- precedent #1089). That table stays.
--
-- 1. LOCK `guests` FIRST, for the reason 0107 gives: drizzle runs every pending
--    migration in ONE transaction and the old container may still be serving, so
--    no guest row is written between the catch-up copy and the DROP.
-- 2. Catch-up copy of what the old container wrote AFTER 0117's snapshot: only a
--    guest row whose value DIFFERS from `guests_contact_backup` (a guest created
--    during that swap has no backup row, so any non-null value differs). A value
--    equal to the backup is not new: it is what 0117 already copied, and copying it
--    again would resurrect a contact an officer deliberately cleared on the Person
--    since, or put a stale address on a fresh Person that separate / unlink / merge
--    re-pointed `guests.person_id` to (possibly a member's). Same target rule as
--    0117: ONLY where the Person is guest-only AND never was a member
--    (`unboundGuestOnlyPerson()` plus `noMemberHistory()` in `account-link-logic.ts`),
--    and ONLY into a NULL field; the OLDEST such guest row wins. Accepted residual:
--    an edit that CHANGED an existing value during that swap is not copied over a
--    non-null field.
-- 3. DROP both columns.
--
-- `src/server/guest-contact-drop-migration.integration.test.ts` runs the real
-- drizzle runner through this file on a scratch database.
LOCK TABLE "guests" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "people" p SET "email" = src."email"
	FROM (
		SELECT DISTINCT ON (g."person_id") g."person_id", g."email"
		FROM "guests" g
		WHERE g."email" IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM "guests_contact_backup" b
				WHERE b."guest_id" = g."id" AND b."email" IS NOT DISTINCT FROM g."email"
			)
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
			AND NOT EXISTS (
				SELECT 1 FROM "guests_contact_backup" b
				WHERE b."guest_id" = g."id" AND b."phone" IS NOT DISTINCT FROM g."phone"
			)
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
ALTER TABLE "guests" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "guests" DROP COLUMN "phone";
