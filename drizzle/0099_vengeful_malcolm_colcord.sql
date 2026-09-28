-- `meeting_votes.anonymous`: an unidentified phone's ballot (#982), stated
-- instead of inferred from "both voter ids NULL", which a removed member's
-- identified vote also reads as (`voter_member_id` is ON DELETE SET NULL).
--
-- `drizzle-kit generate` emits only the ADD COLUMN (IF NOT EXISTS is added by
-- hand, so `voting.integration.test.ts` can apply this file to a push-synced
-- database). The rest is HAND-WRITTEN.
--
-- The trigger is what makes the column true of EVERY insert, not only the new
-- code's. Migrations run at container start while the previous container is
-- still serving (`scripts/migrate.ts`), and that code inserts anonymous ballots
-- without the column, so a plain DEFAULT false would mark them identified and
-- the new `castAnonymousVote` would then count a change from that phone as a
-- second vote. At INSERT time "no voter" IS the fact (a member's removal only
-- nulls the id later, by UPDATE, which this does not fire on), so the trigger
-- derives it and overrides whatever the statement sent.
--
-- Created BEFORE the backfill, so no insert can land between the two unmarked.
-- The backfill marks every row that reads anonymous today, which includes any
-- removed member's vote orphaned before this ran: no worse than the behaviour
-- it replaces, and only rows orphaned AFTER it are told apart.
ALTER TABLE "meeting_votes" ADD COLUMN IF NOT EXISTS "anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION meeting_votes_derive_anonymous() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	NEW.anonymous := NEW.voter_member_id IS NULL AND NEW.voter_guest_id IS NULL;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS meeting_votes_derive_anonymous ON meeting_votes;--> statement-breakpoint
CREATE TRIGGER meeting_votes_derive_anonymous
	BEFORE INSERT ON meeting_votes
	FOR EACH ROW EXECUTE FUNCTION meeting_votes_derive_anonymous();--> statement-breakpoint
UPDATE "meeting_votes" SET "anonymous" = true
WHERE "voter_member_id" IS NULL AND "voter_guest_id" IS NULL;
