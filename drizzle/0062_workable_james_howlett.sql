-- Plain DROP, not DROP ... CASCADE. Nothing depends on either table: both are
-- only the REFERENCING side of their foreign keys (they point at `members` and
-- `meetings`; nothing points at them), and there are no views or triggers on
-- them anywhere in the repo. So CASCADE has nothing to do here today, and its
-- only effect would be on a dependency this repo cannot see — a reporting view
-- or a hand-made FK on the production database — where it would silently
-- destroy that object instead of failing. RESTRICT (the default) aborts the
-- transaction, which fails the deploy closed, which is the Dockerfile's whole
-- contract. drizzle-kit emits CASCADE by default; this is a deliberate edit.
--
-- Deploy note: this drops in the SAME release that stops reading the tables, so
-- between the migration committing and the new container passing its
-- healthcheck, the PREVIOUS release is still serving and its season grid reads
-- `member_availability`. That window is seconds and self-healing, and it is
-- accepted knowingly here (migration 0014 did backfill-then-drop the same way).
DROP TABLE "meeting_outreach";--> statement-breakpoint
DROP TABLE "member_availability";
