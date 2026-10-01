CREATE TABLE "people_phone_backup" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"phone" text,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- #906 — a phone number is a Person fact. `members.phone` is dropped and
-- `people.phone` becomes the one phone column (ADR-0008 already said so; #64 left
-- a per-club copy behind, and the copy is what officers edited while guest
-- conversion deduped on the Person's — #561).
--
-- Before the DROP, each Person takes the phone of their NEWEST membership that
-- has one. "Has one" means at least one digit: a null, empty or digit-free
-- membership phone is absent and never chosen. Newest is `created_at DESC, id
-- DESC` (neither table has `updated_at`). The chosen text is copied VERBATIM —
-- every writer and `scripts/backfill-phone-e164.ts` already store E.164.
--
-- A Person is CHANGED only when its digits differ from the chosen value's
-- digits, which also covers a Person with no phone at all (no digits never equal
-- a chosen value, which always has some). A formatting-only difference is not a
-- change: no write, no backup row. A Person with no present membership phone is
-- never touched, so null is never written over a value.
--
-- Both data statements carry the SAME predicate, so the capture holds exactly
-- the rows the backfill rewrites. Both are idempotent: once the digits agree the
-- predicate is false, and the capture's ON CONFLICT never replaces an earlier
-- snapshot. `src/server/person-phone-migration.integration.test.ts` runs these
-- exact statements, so a regenerated file that lost them fails there.
-- `bun run db:generate` does NOT reproduce them.
--
-- Production on 2026-09-25: 28 memberships, 2 with digits differing from their
-- Person's. Person-null fills add to that count, and are expected.
--
-- ROLLBACK: revert the PR, then ship a migration that re-adds `members.phone`
-- and fills it from `people.phone`. Every membership then gets its Person's
-- current number, which is correct after this change. The pre-migration values
-- of the Persons this rewrote are in `people_phone_backup`.

-- 1. Capture, before anything is overwritten.
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
-- 2. Backfill, with the capture's predicate.
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
