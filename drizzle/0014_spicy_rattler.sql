-- ADR-0008 Phase B (#99): absorb `club_memberships` into the membership row.
-- Move `club_role` onto `members`, migrate roles from `club_memberships` by
-- identity, collapse the enum {admin, vpe, member} → {admin, member}, drop the
-- redundant per-club auth link (`members.user_id`), and delete the legacy auth
-- table. Ordered so no role data is lost and the enum type has no dependents
-- when it is recreated. This runs on the security-critical auth path.

-- 1. Add `club_role` to the membership row using the CURRENT enum (still has
--    'vpe'); everyone starts at the default 'member'.
ALTER TABLE "members" ADD COLUMN "club_role" "club_role" DEFAULT 'member' NOT NULL;--> statement-breakpoint

-- 2. Migrate each `club_memberships` role onto the matching membership. Match by
--    identity: club_memberships.user_id → people.user_id → the `members` row
--    with that person_id and the same club_id. Preserves existing roles (the
--    office default is only for NEW/linked accounts, not this backfill).
UPDATE "members" m
SET "club_role" = cm."club_role"
FROM "club_memberships" cm
JOIN "people" p ON p."user_id" = cm."user_id"
WHERE m."person_id" = p."id" AND m."club_id" = cm."club_id";--> statement-breakpoint

-- 3. Collapse 'vpe' → 'admin' on the membership rows (they behaved identically
--    at every call site, so 'vpe' folds into 'admin').
UPDATE "members" SET "club_role" = 'admin' WHERE "club_role" = 'vpe';--> statement-breakpoint

-- 4. Drop the legacy auth table so nothing else depends on the `club_role` enum
--    type before it is recreated below.
DROP TABLE "club_memberships" CASCADE;--> statement-breakpoint

-- 5. Recreate the `club_role` enum without 'vpe'. Postgres cannot drop an enum
--    value in place, so: drop the default, swap the column to text, drop the old
--    type, create the collapsed type, cast back, restore the default. All values
--    are 'admin'/'member' by now (step 3), so the cast is total.
ALTER TABLE "members" ALTER COLUMN "club_role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "club_role" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."club_role";--> statement-breakpoint
CREATE TYPE "public"."club_role" AS ENUM('admin', 'member');--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "club_role" SET DATA TYPE "public"."club_role" USING "club_role"::"public"."club_role";--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "club_role" SET DEFAULT 'member';--> statement-breakpoint

-- 6. Drop the now-redundant per-club auth link on `members` (the auth-account
--    link is person-level via `people.user_id`).
ALTER TABLE "members" DROP CONSTRAINT "members_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "user_id";
