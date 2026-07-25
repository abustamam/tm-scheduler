ALTER TABLE "role_definitions" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD COLUMN "key" text;--> statement-breakpoint
-- Backfill `key` for role_definitions rows that predate this column. Existing
-- clubs' seeded/backfilled standard roles match a ROLE_TEMPLATE entry
-- (src/lib/role-template.ts) by name — give each its stable, rename-proof key
-- so it works with the later agenda-binding feature (#367) even though the row
-- was created before `key` existed.
--
-- `role_definitions` has no unique constraint on (club_id, name) — the Add
-- Role form posts free text, unchecked — so a club could genuinely have two
-- rows named e.g. "Grammarian". DISTINCT ON (club_id) picks exactly one row
-- per club deterministically (lowest sort_order, then id); any other
-- same-named row's key stays NULL, which is exactly what NULL already means
-- for a club-invented custom role with no canonical identity to key on. This
-- keeps the backfill TOTAL, so the unique index below can never fail on
-- legitimate but oddly-named data — a failed migration here blocks the prod
-- container's startup CMD (`migrate.mjs && server/index.mjs`) for every club,
-- not just the affected one. The `key IS NULL` guard costs nothing to keep
-- even though this file only ever runs once (drizzle tracks applied
-- migrations and runs each file in a transaction).
UPDATE "role_definitions" SET "key" = 'toastmaster_of_the_day'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Toastmaster of the Day' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'table_topics_master'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Table Topics Master' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'speaker'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Speaker' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'evaluator'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Evaluator' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'general_evaluator'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'General Evaluator' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'timer'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Timer' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'ah_counter'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Ah-Counter' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'grammarian'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Grammarian' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
UPDATE "role_definitions" SET "key" = 'vote_counter'
WHERE "key" IS NULL AND "id" IN (
	SELECT DISTINCT ON ("club_id") "id" FROM "role_definitions"
	WHERE "name" = 'Vote Counter' ORDER BY "club_id", "sort_order", "id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "role_definitions_club_key_unique" ON "role_definitions" USING btree ("club_id","key") WHERE "role_definitions"."key" is not null;
