-- Backfill stock role descriptions for clubs that predate them.
--
-- `role_definitions.description` was added nullable in 0002 with no backfill, so
-- every club created before that migration — and every Vote Counter row created
-- by scripts/import-agendas.ts, which used to insert a bare definition — still
-- has a NULL description. Descriptions surface on the printed agenda's role
-- explainers, so those clubs silently render nothing there.
--
-- Matches on the stock role name and only ever writes where description IS NULL,
-- so this is idempotent and never clobbers a description a club has customized.
-- Text is copied verbatim from ROLE_TEMPLATE in src/lib/role-template.ts.
--
-- Deliberately does NOT create missing Vote Counter definitions: adding a role
-- adds an agenda row to every future meeting, which is a club's decision, not a
-- migration's. New clubs get it from ROLE_TEMPLATE; existing clubs can add it
-- from /admin/roles.

UPDATE "role_definitions" AS rd
SET "description" = stock.description
FROM (
	VALUES
		('Toastmaster of the Day', 'Hosts the meeting: sets the theme, introduces each speaker and segment, and keeps energy and timing on track. Prep: review the agenda beforehand.'),
		('Table Topics Master', 'Leads the impromptu speaking segment by preparing 8–10 questions or scenarios and calling on members or guests to respond on the spot.'),
		('Speaker', 'Delivers a prepared speech from your Pathways project; coordinate with your evaluator on the project objectives and time target before the meeting.'),
		('Evaluator', 'Provides structured written and verbal feedback on your assigned speaker''s delivery, language, and achievement of their project goals.'),
		('General Evaluator', 'Oversees meeting quality by evaluating all roles (except speakers) and summarizing feedback from the Timer, Ah-Counter, and Grammarian.'),
		('Timer', 'Tracks and displays time signals for every speaker and evaluator, then reports any overtime violations to the General Evaluator at the end of the meeting.'),
		('Ah-Counter', 'Tallies filler words (um, ah, so, you know, like) for each speaker during the meeting and reports the counts in the evaluation segment.'),
		('Grammarian', 'Introduces a Word of the Day, monitors language use throughout the meeting, and commends creative phrasing while noting grammatical slips in the evaluation segment.'),
		('Vote Counter', 'Distributes and collects ballots for Best Speaker, Best Evaluator, and Best Table Topics, tallies the votes discreetly, and hands the results to the Toastmaster before the awards are announced.')
) AS stock(name, description)
WHERE rd."name" = stock.name AND rd."description" IS NULL;
