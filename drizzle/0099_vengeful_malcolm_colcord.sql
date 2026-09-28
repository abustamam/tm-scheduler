-- `meeting_votes.anonymous`: an unidentified phone's ballot (#982), stated
-- instead of inferred from "both voter ids NULL", which a removed member's
-- identified vote also reads as (`voter_member_id` is ON DELETE SET NULL).
--
-- `drizzle-kit generate` emits only the ADD COLUMN. The backfill is
-- HAND-WRITTEN: every row that reads anonymous today is marked anonymous, so
-- `castAnonymousVote` keeps finding the ballots it finds now. That includes any
-- removed member's vote already orphaned before this ran, which is no worse than
-- the behaviour it replaces; only rows orphaned AFTER it are told apart.
ALTER TABLE "meeting_votes" ADD COLUMN "anonymous" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "meeting_votes" SET "anonymous" = true
WHERE "voter_member_id" IS NULL AND "voter_guest_id" IS NULL;
