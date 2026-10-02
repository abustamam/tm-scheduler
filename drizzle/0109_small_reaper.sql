-- #907 — an email address is a Person fact. `members.email` is dropped and
-- `people.email` becomes the one address column: the contact address in every
-- club, the dedupe key, and the key a sign-in binds on (ADR-0029). #756 had
-- split it in two — a verified `people.email` and a per-club, officer-typed
-- `members.email` the bind used as its vouch — which left a member of two clubs
-- unable to sign in by email at all.
--
-- 0. LOCK `members` FIRST, before anything is read from it, for the reason 0107
--    gives: drizzle runs every pending migration in ONE transaction at READ
--    COMMITTED and the old container keeps serving until the new one is
--    healthy, so an old-container edit to `members.email` landing between the
--    capture and the DROP would otherwise escape the backup.
--    `scripts/migrate.ts` bounds the wait for it. `people` is NOT locked: a
--    bind landing mid-migration sets `user_id`, and the backfill's own
--    `user_id IS NULL` is re-checked against the committed row, so it skips
--    it (at worst leaving a harmless extra row in the backup).
--
-- Then, before the DROP, each UNBOUND Person (`user_id IS NULL`) takes the one
-- address its memberships agree on:
--   - the distinct normalised non-empty `members.email` values across ALL its
--     memberships (null and blank are absent; normalised = whitespace-trimmed,
--     lower-cased, the spelling `normalizedEmail` uses);
--   - EXACTLY ONE distinct value → the Person takes it, as the NEWEST such
--     membership's trimmed text (`created_at DESC, id DESC`);
--   - zero → untouched; two or more → untouched (a superadmin reconciles them;
--     the PR lists them — production had none on 2026-09-25).
-- A BOUND Person keeps `people.email`: it is the address a magic link proved.
-- A Person is CHANGED only when its normalised address differs from the chosen
-- one, so a case- or whitespace-only difference writes nothing and backs up
-- nothing. Two Persons may end up with one normalised address; the bind then
-- refuses both and `listDuplicatePeople` shows the pair for a manual merge.
--
-- TWO undo tables, both with no foreign keys:
--   `members_email_backup`   — every non-blank membership address, as stored.
--   `people_email_backup_2`  — the old value of every Person the backfill
--     rewrites (null included, for a fill). The capture and the backfill carry
--     the SAME predicate, so it holds exactly the rows the backfill changes.
-- Every data statement is idempotent. `src/server/person-email-migration.integration.test.ts`
-- runs these exact statements, so a regenerated file that lost them fails there.
-- `bun run db:generate` reproduces only the two CREATE TABLEs and the DROP.
--
-- ROLLBACK: revert the PR, then ship a migration that re-adds `members.email`
-- and fills it from `people.email` for every membership (correct for everyone:
-- each membership gets its Person's one address), or from `members_email_backup`
-- for the exact per-club values. Restore `people.email` from
-- `people_email_backup_2` ONLY where `people.user_id` is still null — an address
-- a bind has since verified must never be overwritten by this snapshot.
LOCK TABLE "members" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "members_email_backup" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"club_id" uuid,
	"person_id" uuid,
	"email" text,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_email_backup_2" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 1. Every membership address the DROP will destroy, as stored.
INSERT INTO "members_email_backup" ("member_id", "club_id", "person_id", "email")
SELECT m."id", m."club_id", m."person_id", m."email"
FROM "members" m
WHERE regexp_replace(coalesce(m."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
ON CONFLICT ("member_id") DO NOTHING;--> statement-breakpoint
-- 2. Every Person the backfill is about to overwrite, before it does.
INSERT INTO "people_email_backup_2" ("person_id", "email")
SELECT p."id", p."email"
FROM "people" p
JOIN (
	SELECT DISTINCT ON (m."person_id") m."person_id",
		regexp_replace(m."email", '^[[:space:]]+|[[:space:]]+$', '', 'g') AS "email"
	FROM "members" m
	WHERE regexp_replace(coalesce(m."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
		AND (
			SELECT count(DISTINCT lower(regexp_replace(m2."email", '^[[:space:]]+|[[:space:]]+$', '', 'g')))
			FROM "members" m2
			WHERE m2."person_id" = m."person_id"
				AND regexp_replace(coalesce(m2."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
		) = 1
	ORDER BY m."person_id", m."created_at" DESC, m."id" DESC
) chosen ON chosen."person_id" = p."id"
WHERE p."user_id" IS NULL
	AND lower(regexp_replace(coalesce(p."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'))
		<> lower(chosen."email")
ON CONFLICT ("person_id") DO NOTHING;--> statement-breakpoint
-- 3. Backfill, with the capture's predicate.
UPDATE "people" p
SET "email" = chosen."email"
FROM (
	SELECT DISTINCT ON (m."person_id") m."person_id",
		regexp_replace(m."email", '^[[:space:]]+|[[:space:]]+$', '', 'g') AS "email"
	FROM "members" m
	WHERE regexp_replace(coalesce(m."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
		AND (
			SELECT count(DISTINCT lower(regexp_replace(m2."email", '^[[:space:]]+|[[:space:]]+$', '', 'g')))
			FROM "members" m2
			WHERE m2."person_id" = m."person_id"
				AND regexp_replace(coalesce(m2."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
		) = 1
	ORDER BY m."person_id", m."created_at" DESC, m."id" DESC
) chosen
WHERE chosen."person_id" = p."id"
	AND p."user_id" IS NULL
	AND lower(regexp_replace(coalesce(p."email", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'))
		<> lower(chosen."email");--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "email";
