-- Give every existing club a Vote Counter role definition.
--
-- Vote Counter became part of ROLE_TEMPLATE (src/lib/role-template.ts), but the
-- template only runs at club creation, so existing clubs would never get it.
-- Before this, the only clubs with a Vote Counter were those the agenda importer
-- (scripts/import-agendas.ts) happened to touch.
--
-- Guarded by NOT EXISTS on the club/name pair, so this is idempotent and skips
-- clubs that already have the role (however it got there). Column values match
-- the ROLE_TEMPLATE entry exactly.
--
-- Adding a definition does NOT retroactively add slots to already-scheduled
-- meetings — it takes effect for meetings built from the club's role template
-- from here on.

INSERT INTO "role_definitions" ("club_id", "name", "category", "default_count", "sort_order", "is_speaker_role", "description")
SELECT
	c."id",
	'Vote Counter',
	'functionary',
	1,
	90,
	false,
	'Distributes and collects ballots for Best Speaker, Best Evaluator, and Best Table Topics, tallies the votes discreetly, and hands the results to the Toastmaster before the awards are announced.'
FROM "clubs" c
WHERE NOT EXISTS (
	SELECT 1
	FROM "role_definitions" rd
	WHERE rd."club_id" = c."id" AND rd."name" = 'Vote Counter'
);
