-- #906 — a phone number is a Person fact. `members.phone` is dropped and
-- `people.phone` becomes the one phone column (ADR-0008 already said so; #64 left
-- a per-club copy behind, and the copy is what officers edited while guest
-- conversion deduped on the Person's — #561).
--
-- 0. LOCK `members` FIRST, before anything is read from it. drizzle runs every
--    pending migration in ONE transaction at READ COMMITTED, and Railway's old
--    container keeps serving until the new one is healthy — so without this, an
--    old-container edit to `members.phone` landing between the capture and the
--    backfill escapes the backup, and one landing after the backfill but before
--    the DROP is silently lost. The DROP takes ACCESS EXCLUSIVE anyway; taking it
--    up front closes those windows and avoids a lock upgrade mid-transaction.
--    `scripts/migrate.ts` bounds the wait for it.
--
-- Then, before the DROP, each Person takes the phone of their NEWEST membership
-- that has one. "Has one" means at least one digit: a null, empty or digit-free
-- membership phone is absent and never chosen. Newest is `created_at DESC, id
-- DESC` (neither table has `updated_at`). The chosen text is copied VERBATIM —
-- every writer and `scripts/backfill-phone-e164.ts` already store E.164.
--
-- A Person is CHANGED only when its digits differ from the chosen value's
-- digits, which also covers a Person with no phone at all (no digits never equal
-- a chosen value, which always has some). A difference in formatting alone (the
-- same digit string) is not a change: no write, no backup row. A national number
-- against its E.164 form IS a digit difference ("4155550100" vs "14155550100")
-- and is overwritten with the membership's value; the PR's prod check counts
-- those separately as `format_only`. A Person with no present membership phone
-- is never touched, so null is never written over a value.
--
-- TWO undo tables, both with no foreign keys:
--   `members_phone_backup` — every membership phone with a digit, as stored. The
--     backfill keeps one number per Person, so a correct number on an OLDER
--     membership would otherwise be destroyed by the DROP.
--   `people_phone_backup`  — the old value of every Person the backfill rewrites
--     (null included, for a fill). The capture and the backfill carry the SAME
--     predicate, so it holds exactly the rows the backfill changes.
-- Every data statement is idempotent: once the digits agree the backfill's
-- predicate is false, and both captures' ON CONFLICT never replaces an earlier
-- snapshot. `src/server/person-phone-migration.integration.test.ts` runs these
-- exact statements, so a regenerated file that lost them fails there.
-- `bun run db:generate` reproduces only the two CREATE TABLEs and the DROP.
--
-- Production on 2026-09-25: 28 memberships, 2 with digits differing from their
-- Person's. Person-null fills add to that count, and are expected.
--
-- ROLLBACK: revert the PR, then ship a migration that re-adds `members.phone`
-- and fills it from `members_phone_backup` (exact per-membership values) or from
-- `people.phone`. The pre-migration values of the Persons this rewrote are in
-- `people_phone_backup`.
LOCK TABLE "members" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "people_phone_backup" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"phone" text,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members_phone_backup" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"club_id" uuid,
	"person_id" uuid,
	"phone" text,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 1. Every membership phone the DROP will destroy, as stored.
INSERT INTO "members_phone_backup" ("member_id", "club_id", "person_id", "phone")
SELECT m."id", m."club_id", m."person_id", m."phone"
FROM "members" m
WHERE regexp_replace(coalesce(m."phone", ''), '[^0-9]', '', 'g') <> ''
ON CONFLICT ("member_id") DO NOTHING;--> statement-breakpoint
-- 2. Every Person the backfill is about to overwrite, before it does.
INSERT INTO "people_phone_backup" ("person_id", "phone")
SELECT p."id", p."phone"
FROM "people" p
JOIN (
	SELECT DISTINCT ON (m."person_id") m."person_id", m."phone"
	FROM "members" m
	WHERE regexp_replace(coalesce(m."phone", ''), '[^0-9]', '', 'g') <> ''
	ORDER BY m."person_id", m."created_at" DESC, m."id" DESC
) chosen ON chosen."person_id" = p."id"
WHERE regexp_replace(coalesce(p."phone", ''), '[^0-9]', '', 'g')
	<> regexp_replace(chosen."phone", '[^0-9]', '', 'g')
ON CONFLICT ("person_id") DO NOTHING;--> statement-breakpoint
-- 3. Backfill, with the capture's predicate.
UPDATE "people" p
SET "phone" = chosen."phone"
FROM (
	SELECT DISTINCT ON (m."person_id") m."person_id", m."phone"
	FROM "members" m
	WHERE regexp_replace(coalesce(m."phone", ''), '[^0-9]', '', 'g') <> ''
	ORDER BY m."person_id", m."created_at" DESC, m."id" DESC
) chosen
WHERE chosen."person_id" = p."id"
	AND regexp_replace(coalesce(p."phone", ''), '[^0-9]', '', 'g')
		<> regexp_replace(chosen."phone", '[^0-9]', '', 'g');--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "phone";
