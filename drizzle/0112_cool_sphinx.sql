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
-- `phone_extension_backup` takes every changed row's table, id and original value
-- BEFORE the rewrite, so the repair can be undone. Both statements of each pair
-- carry the same predicate, and the capture's ON CONFLICT never replaces an
-- earlier snapshot. `src/server/phone-extension-repair.integration.test.ts` runs
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
INSERT INTO "phone_extension_backup" ("source_table", "row_id", "phone")
SELECT 'people', "id", "phone" FROM "people"
WHERE "phone" ~ '^\+1[0-9]+$'
	AND length("phone") > 12
	AND NOT (length("phone") = 13 AND "phone" LIKE '+11%')
ON CONFLICT ("source_table", "row_id") DO NOTHING;--> statement-breakpoint
UPDATE "people"
SET "phone" = substr("phone", 1, 12)
WHERE "phone" ~ '^\+1[0-9]+$'
	AND length("phone") > 12
	AND NOT (length("phone") = 13 AND "phone" LIKE '+11%');
--> statement-breakpoint
INSERT INTO "phone_extension_backup" ("source_table", "row_id", "phone")
SELECT 'guests', "id", "phone" FROM "guests"
WHERE "phone" ~ '^\+1[0-9]+$'
	AND length("phone") > 12
	AND NOT (length("phone") = 13 AND "phone" LIKE '+11%')
ON CONFLICT ("source_table", "row_id") DO NOTHING;--> statement-breakpoint
UPDATE "guests"
SET "phone" = substr("phone", 1, 12)
WHERE "phone" ~ '^\+1[0-9]+$'
	AND length("phone") > 12
	AND NOT (length("phone") = 13 AND "phone" LIKE '+11%');
--> statement-breakpoint
INSERT INTO "phone_extension_backup" ("source_table", "row_id", "phone")
SELECT 'club_charter_helpers', "id", "phone" FROM "club_charter_helpers"
WHERE "phone" ~ '^\+1[0-9]+$'
	AND length("phone") > 12
	AND NOT (length("phone") = 13 AND "phone" LIKE '+11%')
ON CONFLICT ("source_table", "row_id") DO NOTHING;--> statement-breakpoint
UPDATE "club_charter_helpers"
SET "phone" = substr("phone", 1, 12)
WHERE "phone" ~ '^\+1[0-9]+$'
	AND length("phone") > 12
	AND NOT (length("phone") = 13 AND "phone" LIKE '+11%');
