-- #1157 / ADR-0029: an address typed without an officer's session is a club's
-- unconfirmed note on its own guest row, not a Person fact.
--
-- 1. The column: `guests.book_email`, the public guest book's note. It matches
--    guest cards and addresses the minutes email draft; it reaches
--    `people.email` only when an officer confirms it (convert, Edit guest).
-- 2. Move what the book already wrote. A Person that is GUEST-ONLY (never signed
--    in, no membership in any club) and named by at least one guest row has
--    its address copied onto every guest row naming it, then cleared from the
--    Person. A Person with no guest row keeps its address (no card to carry it),
--    and so does any member's or signed-in Person's: those are vouched.
-- 3. Both data statements are idempotent and fail closed: a re-run copies
--    nothing new (the Person's address is already NULL) and an address an
--    officer typed in the meantime is simply re-confirmed at convert.
--
-- The old container may still serve while this runs and can write an address in
-- that overlap; the PR's `## Prod check` says how to re-run statements 2 and 3.
--
-- Rollback: the column holds every address statement 3 nulled, so
--   UPDATE people p SET email = g.book_email FROM guests g
--   WHERE g.person_id = p.id AND p.email IS NULL AND g.book_email IS NOT NULL
-- restores them (by hand for a Person whose guest rows carry two different ones).
ALTER TABLE "guests" ADD COLUMN "book_email" text;--> statement-breakpoint
UPDATE "guests" g SET "book_email" = p."email"
	FROM "people" p
	WHERE g."person_id" = p."id"
		AND p."email" IS NOT NULL
		AND p."user_id" IS NULL
		AND NOT EXISTS (SELECT 1 FROM "members" m WHERE m."person_id" = p."id");--> statement-breakpoint
UPDATE "people" p SET "email" = NULL
	WHERE p."email" IS NOT NULL
		AND p."user_id" IS NULL
		AND NOT EXISTS (SELECT 1 FROM "members" m WHERE m."person_id" = p."id")
		AND EXISTS (SELECT 1 FROM "guests" g WHERE g."person_id" = p."id");
