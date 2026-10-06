-- #1106 -- `toE164` now drops a phone extension, so the rows that already carry
-- one folded into the digits are repaired here. A stored `+1` number has exactly
-- 10 digits after the country code; anything longer is extension digits, so the
-- value becomes `+1` plus its first 10 digits.
--
-- Scope: `people.phone`, `guests.phone`, `club_charter_helpers.phone` (every phone
-- column in schema.ts). Only values that are `+` and digits, start `+1`, and have
-- more than 11 digits after the `+`. The 12-digit `+11...` shape is the domestic
-- `1` stacked on `+1` that `repairIntlDigits` owns, not an extension: left alone.
-- Non-`+1` rows are left alone; no safe rule exists for other country codes.
--
-- A `+11...` value longer than 13 chars is a domestic `1` plus an extension (the
-- old code stored `1-415-555-2671 x9` as `+1141555526719`): it becomes `+1` plus
-- the 10 digits after the `11`, which is what the new `toE164` gives. Any other
-- value becomes its first 12 chars (`+1` and 10 digits). Already-wrong `+144...`
-- values (UK digits typed in a +1 club) are truncated too; the backup keeps them.
--
-- ONE statement per table: a CTE locks the matching rows (FOR UPDATE), copies
-- each to `phone_extension_backup` (table, id, original value), and rewrites
-- exactly those rows, so a row written during the deploy cannot be rewritten
-- without a backup. The capture's ON CONFLICT never replaces an earlier snapshot. `src/server/phone-extension-repair.integration.test.ts` runs
-- these exact statements. `bun run db:generate` reproduces only the CREATE TABLE.
--
-- ROLLBACK: revert the PR, then restore each `phone` from `phone_extension_backup`
-- by (source_table, row_id).
CREATE TABLE "phone_extension_backup" (
	"source_table" text NOT NULL,
	"row_id" uuid NOT NULL,
	"phone" text,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "phone_extension_backup_source_table_row_id_pk" PRIMARY KEY("source_table","row_id")
);--> statement-breakpoint
WITH old AS (
	SELECT "id", "phone" FROM "people"
	WHERE "phone" ~ '^\+1[0-9]+$'
		AND length("phone") > 12
		AND NOT (length("phone") = 13 AND "phone" LIKE '+11%')
	FOR UPDATE
), ins AS (
	INSERT INTO "phone_extension_backup" ("source_table", "row_id", "phone")
	SELECT 'people', "id", "phone" FROM old
	ON CONFLICT ("source_table", "row_id") DO NOTHING
)
UPDATE "people" t
SET "phone" = CASE WHEN old."phone" LIKE '+11%'
	THEN '+1' || substr(old."phone", 4, 10)
	ELSE substr(old."phone", 1, 12) END
FROM old
WHERE t."id" = old."id";
--> statement-breakpoint
WITH old AS (
	SELECT "id", "phone" FROM "guests"
	WHERE "phone" ~ '^\+1[0-9]+$'
		AND length("phone") > 12
		AND NOT (length("phone") = 13 AND "phone" LIKE '+11%')
	FOR UPDATE
), ins AS (
	INSERT INTO "phone_extension_backup" ("source_table", "row_id", "phone")
	SELECT 'guests', "id", "phone" FROM old
	ON CONFLICT ("source_table", "row_id") DO NOTHING
)
UPDATE "guests" t
SET "phone" = CASE WHEN old."phone" LIKE '+11%'
	THEN '+1' || substr(old."phone", 4, 10)
	ELSE substr(old."phone", 1, 12) END
FROM old
WHERE t."id" = old."id";
--> statement-breakpoint
WITH old AS (
	SELECT "id", "phone" FROM "club_charter_helpers"
	WHERE "phone" ~ '^\+1[0-9]+$'
		AND length("phone") > 12
		AND NOT (length("phone") = 13 AND "phone" LIKE '+11%')
	FOR UPDATE
), ins AS (
	INSERT INTO "phone_extension_backup" ("source_table", "row_id", "phone")
	SELECT 'club_charter_helpers', "id", "phone" FROM old
	ON CONFLICT ("source_table", "row_id") DO NOTHING
)
UPDATE "club_charter_helpers" t
SET "phone" = CASE WHEN old."phone" LIKE '+11%'
	THEN '+1' || substr(old."phone", 4, 10)
	ELSE substr(old."phone", 1, 12) END
FROM old
WHERE t."id" = old."id";
