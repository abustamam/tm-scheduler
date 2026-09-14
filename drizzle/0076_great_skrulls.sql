CREATE TABLE "people_email_backup" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people_email_backup" ADD CONSTRAINT "people_email_backup_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
-- The three statements below are HAND-WRITTEN and `bun run db:generate` will not
-- reproduce them. `src/server/person-email-clear-migration.integration.test.ts`
-- runs these exact statements against seeded rows, so a regenerated file that
-- lost them fails there.
--
-- TO REVERSE (with the PR reverted):
--   UPDATE "people" p SET "email" = b."email"
--   FROM "people_email_backup" b
--   WHERE p."id" = b."person_id" AND p."user_id" IS NULL;
-- then drop `people_email_backup` once a release has passed.

-- 1. Capture, before anything is destroyed. ON CONFLICT so a hand re-run during
--    an incident cannot overwrite the original snapshot with a later value.
INSERT INTO "people_email_backup" ("person_id", "email")
SELECT "id", "email" FROM "people"
WHERE "user_id" IS NULL AND "email" IS NOT NULL
ON CONFLICT ("person_id") DO NOTHING;--> statement-breakpoint
-- 2. Fail closed if the clear would leave a MEMBER with no address anywhere.
--    Such a member can be neither invited nor claimed nor repaired by any club
--    surface, so this is worse than not migrating. The count was 0 in
--    production, and is re-checked here because the reading and the deploy are
--    not the same moment. A non-zero exit fails the Railway deploy before the
--    server serves traffic (CLAUDE.md, "Deployment target").
--
--    "Member" is load-bearing in the first EXISTS. A Person with NO membership
--    at all is nobody's member — un-invitable and un-claimable before this
--    migration as much as after, so clearing their address strands no one, and
--    they are not rare (`mergePeople` leaves absorbed rows behind, the guest
--    pipeline mints one ahead of a conversion). Counting them would fail a
--    production deploy over an orphan row, which is a worse outcome than the one
--    this check exists to prevent.
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
-- 3. Clear. Scoped to un-claimed Persons only — `user_id IS NOT NULL` means the
--    address IS the verified one, which is the whole point of keeping it.
UPDATE "people" SET "email" = NULL WHERE "user_id" IS NULL;
