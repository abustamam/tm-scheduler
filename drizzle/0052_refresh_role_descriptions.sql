-- Refresh three ROLE_TEMPLATE descriptions that contradicted the run-of-show
-- v1.1.0.0 made explicit (#444, deferred from #363).
--
-- `role_definitions.description` is a per-club row seeded from ROLE_TEMPLATE
-- (src/lib/role-template.ts) at club creation, so editing the template alone
-- only helps clubs created after this deploy. Existing clubs keep the stale
-- text forever unless something backfills them.
--
-- GUARDED BY EXACT MATCH ON THE OLD SEEDED STRING. A club can edit these from
-- /admin/roles (roles.tsx posts a `description` field, and
-- `applyRoleDefinitionUpdate` accepts it), so a blanket UPDATE would silently
-- overwrite anything a club wrote for itself. Matching the previous seeded text
-- exactly means only provably-unedited rows move: any club that customised its
-- copy keeps it, and the row count this reports tells us whether the
-- "nobody has edited these" assumption actually held.
--
-- Keyed on `key` rather than `name` so a club that RENAMED one of these roles
-- still gets the refresh — the key is the stable identity (#368), and the
-- descriptions are about what the role DOES, which a rename does not change.
-- Rows with a NULL key (club-invented, or predating the 0044 backfill) are left
-- alone: there is no canonical role for them to be stale against.
--
-- Idempotent by construction: after this runs, no row matches the old string.

-- Timer. The old text said the report goes to the General Evaluator "at the end
-- of the meeting". That describes the closing summary and misses the per-segment
-- timings the agenda calls for before each vote — Best Speaker cannot be voted
-- on until the room knows who qualified. Both happen; the new wording covers
-- both instead of naming only one and pinning it to a moment.
UPDATE "role_definitions" SET "description" =
	'Tracks and displays time signals for every speaker and evaluator, and presents a report whenever the meeting leader calls for one.'
WHERE "key" = 'timer' AND "description" =
	'Tracks and displays time signals for every speaker and evaluator, then reports any overtime violations to the General Evaluator at the end of the meeting.';
--> statement-breakpoint

-- General Evaluator. Never mentioned introducing the speech evaluators, which
-- the printed agenda now asks them to do by name.
UPDATE "role_definitions" SET "description" =
	'Oversees meeting quality by evaluating all roles (except speakers) and summarizing feedback from the Timer, Ah-Counter, and Grammarian; introduces the speech evaluators.'
WHERE "key" = 'general_evaluator' AND "description" =
	'Oversees meeting quality by evaluating all roles (except speakers) and summarizing feedback from the Timer, Ah-Counter, and Grammarian.';
--> statement-breakpoint

-- Table Topics Master. Said nothing about handing the meeting on at the end of
-- the segment, which is a hand-off row on the agenda carrying their name.
-- Deliberately vague about the TARGET: it is the General Evaluator at a club
-- that runs one and the Toastmaster otherwise (the beat's fallback), and a role
-- sheet that names the wrong person is worse than one that names none.
UPDATE "role_definitions" SET "description" =
	'Leads the impromptu speaking segment by preparing 8–10 questions or scenarios and calling on members or guests to respond on the spot, then hands the meeting back over.'
WHERE "key" = 'table_topics_master' AND "description" =
	'Leads the impromptu speaking segment by preparing 8–10 questions or scenarios and calling on members or guests to respond on the spot.';
