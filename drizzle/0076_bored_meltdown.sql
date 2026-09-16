CREATE TABLE "people_email_backup" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- #756 — invert the ownership of `people.email`.
--
-- The column is now the VERIFIED identity address: only the sign-in bind writes
-- it, using an address a magic link just proved. Every value written BEFORE this
-- migration was typed by a club officer, an importer or a guest-book form, so
-- none of them mean what the column now claims. The un-claimed ones are cleared;
-- an account holder's is left alone, because signing in is exactly the proof.
--
-- Measured against production on 2026-09-14: 15 rows affected, all 15 with a
-- `members.email` to fall back to, 0 stranded, and 0 whose value differed from
-- the roster address — a behavioural no-op for every affected member.
--
-- **SINGLE-USE. Do NOT re-run this file by hand.** drizzle applies it once and
-- records it, which is the only execution it is written for. Statement 3 is
-- unscoped in time, so a second run would clear the dedupe key on every Person
-- CREATED SINCE the deploy — the CSV importer, the guest-book conversion, the
-- bulk paste and the create-club form all still write `people.email` on INSERT.
-- An earlier draft of this header invited a hand re-run and called it a no-op;
-- it is not, and the test that "proved" it only re-ran against rows the first
-- pass had already emptied.
--
-- LOCKING, at the sizes that make this acceptable. drizzle wraps every pending
-- migration in ONE transaction, and Railway's old container keeps serving until
-- the new one is healthy, so every lock taken here is held against live traffic
-- until commit. Statement 3 row-locks what it rewrites; the CREATE TABLE above
-- takes nothing on `people`, which is why it carries NO foreign key (see the
-- schema comment on `peopleEmailBackup` — the reference would also have let
-- `mergePeople` cascade the snapshot away). Production `people` is 28 rows; at
-- six figures statement 3 needs batching by primary-key range outside the
-- migrator instead.
--
-- The three data statements below are HAND-WRITTEN and `bun run db:generate`
-- will not reproduce them. `src/server/person-email-clear-migration.integration.test.ts`
-- runs these exact statements against seeded rows, so a regenerated file that
-- lost them fails there.
--
-- **ROLLBACK — reverting the PR alone is NOT a valid rollback.** The old
-- `linkPersonToUser` matched `lower(people.email)`, so a reverted deploy against
-- a migrated database leaves every cleared member unable to auto-link: a state
-- neither the old code nor the new produces. The compensating UPDATE must be run.
--
-- In PRODUCTION, run it inside the database service — `scripts/rollback-0076.ts`
-- is NOT bundled into `.output/` and the runtime image has no Bun, and
-- `railway run` executes locally against a private host that does not resolve
-- off-platform:
--
--   railway ssh --service Postgres -- psql -X -c "UPDATE \"people\" p \
--     SET \"email\" = b.\"email\" FROM \"people_email_backup\" b \
--     WHERE p.\"id\" = b.\"person_id\" AND p.\"user_id\" IS NULL \
--     AND p.\"email\" IS NULL;"
--
-- `bun run rollback:0076` runs the same statement against a local or staging
-- database, and with `--apply` omitted prints the full accounting (how many
-- snapshot rows are restorable, how many belong to a Person since merged away,
-- how many have already signed in or been repaired).
--
-- The `p."email" IS NULL` arm is load-bearing: without it the restore clobbers
-- any address the sanctioned non-bind writers set AFTER the migration
-- (`updateUnclaimedAdminEmail`, `mergePeople`'s keeper fill), undoing an
-- operator's repair during the very incident that triggered the rollback.
-- Drop `people_email_backup` by REMOVING it from `schema.ts` and shipping the
-- generated migration, not by hand: a hand-drop puts production out of step with
-- the snapshot, and the later generated `DROP TABLE` carries no IF EXISTS, so it
-- would fail the deploy closed at container start.

-- 1. Capture, before anything is destroyed. ON CONFLICT so a re-run can never
--    overwrite the original snapshot with a later value.
INSERT INTO "people_email_backup" ("person_id", "email")
SELECT "id", "email" FROM "people"
WHERE "user_id" IS NULL AND "email" IS NOT NULL
ON CONFLICT ("person_id") DO NOTHING;--> statement-breakpoint
-- 2. Fail closed if the clear would leave a MEMBER with no address anywhere.
--    Such a member can be neither invited nor claimed nor repaired by any club
--    surface, so this is worse than not migrating. The count was 0 in
--    production, and is re-checked here because the reading and the deploy are
--    not the same moment. A non-zero exit fails the Railway deploy before the
--    server serves traffic (CLAUDE.md, "Deployment target"), and SQLSTATE P0001
--    is deliberately absent from `scripts/migrate.ts`'s retryable list, so it
--    fails on the first attempt rather than burning the retry budget.
--
--    "Member" is load-bearing in the first EXISTS. A Person with NO membership
--    at all is nobody's member — un-invitable and un-claimable before this
--    migration as much as after, so clearing their address strands no one. They
--    arise from a roster removal (`applyMemberRemove` leaves the Person) and
--    from undoing a guest conversion; counting them would fail a production
--    deploy over an orphan row, which is a worse outcome than the one this check
--    exists to prevent.
DO $$
DECLARE
	stranded integer;
BEGIN
	SELECT count(*) INTO stranded
	FROM "people" p
	WHERE p."user_id" IS NULL
		AND p."email" IS NOT NULL
		AND EXISTS (SELECT 1 FROM "members" m WHERE m."person_id" = p."id")
		AND NOT EXISTS (
			SELECT 1 FROM "members" m
			WHERE m."person_id" = p."id"
				AND m."email" IS NOT NULL
				AND length(trim(m."email")) > 0
		);
	IF stranded > 0 THEN
		RAISE EXCEPTION
			'0076 aborted: % un-claimed members would be left with no email on any roster row. Put the address on members.email for each, then redeploy.',
			stranded;
	END IF;
END $$;--> statement-breakpoint
-- 3. Clear. Two predicates, both load-bearing:
--      `user_id IS NULL`   — a linked Person's address IS the verified one.
--      `email IS NOT NULL` — Postgres writes a new tuple version for every
--                            matched row whether or not the value changes, so
--                            without this the statement rewrites every
--                            un-claimed Person (and its index entry) to set NULL
--                            to NULL. It matches the capture's predicate above.
UPDATE "people" SET "email" = NULL
WHERE "user_id" IS NULL AND "email" IS NOT NULL;
