CREATE TYPE "public"."officer_position" AS ENUM('president', 'vp_education', 'vp_membership', 'vp_public_relations', 'secretary', 'treasurer', 'sergeant_at_arms', 'immediate_past_president');--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "officer_position" "officer_position";--> statement-breakpoint
-- Convert the old free-text `office` into the structured enum where parseable
-- (mirrors parseOfficerPosition in src/lib/officers.ts). Order matters: VP roles
-- and Immediate Past President are matched before the bare "president" rule so
-- they aren't swallowed by it. Unparseable / blank offices become NULL (no office).
UPDATE "members" SET "officer_position" = (
	CASE
		WHEN "office" ~* 'past.?president|\yipp\y' THEN 'immediate_past_president'
		WHEN "office" ~* 'vp.*edu|vice.?president.*edu|\yvpe\y' THEN 'vp_education'
		WHEN "office" ~* 'vp.*mem|vice.?president.*mem|\yvpm\y' THEN 'vp_membership'
		WHEN "office" ~* 'vp.*(pub|pr)|vice.?president.*(pub|rel)|\yvppr\y' THEN 'vp_public_relations'
		WHEN "office" ~* 'president' AND "office" !~* 'vice|vp\y' THEN 'president'
		WHEN "office" ~* 'secretar' THEN 'secretary'
		WHEN "office" ~* 'treasur' THEN 'treasurer'
		WHEN "office" ~* 'sergeant|sgt|\yarms\y|\ysaa\y' THEN 'sergeant_at_arms'
		ELSE NULL
	END
)::"public"."officer_position"
WHERE "office" IS NOT NULL AND btrim("office") <> '';--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "office";
