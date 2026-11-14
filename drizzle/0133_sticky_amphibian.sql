ALTER TABLE "meeting_template_beats" ADD COLUMN "award_category" "award_category";--> statement-breakpoint
-- Backfill (#1635): mark the three vote beats `materialiseRunOfShow` emits, on
-- rows saved before the column existed. A beat is marked only when its role_key
-- is the segment LEADER's and its detail is the materialised vote string
-- VERBATIM, with or without the timer's-report clause (the `fallbacks` variant).
-- Never inside a speech-contest template (a contest is judged on paper). A
-- hand-edited vote step no longer matches and stays NULL, as does any hand-added
-- one: no QR rather than a guessed one.
UPDATE "meeting_template_beats" AS b
SET "award_category" = v.category::"award_category"
FROM "meeting_templates" AS t,
	(VALUES
		('toastmaster_of_the_day', 'Calls for the {role:timer}''s report · calls for votes for Best Speaker', 'best_speaker'),
		('toastmaster_of_the_day', 'Calls for votes for Best Speaker', 'best_speaker'),
		('table_topics_master', 'Calls for the {role:timer}''s report · calls for votes for Best Table Topics', 'best_table_topics'),
		('table_topics_master', 'Calls for votes for Best Table Topics', 'best_table_topics'),
		('general_evaluator', 'Calls for the {role:timer}''s report · calls for votes for Best Evaluator', 'best_evaluator'),
		('general_evaluator', 'Calls for votes for Best Evaluator', 'best_evaluator')
	) AS v(role_key, detail, category)
WHERE b."template_id" = t."id"
	AND t."key" <> 'speech_contest'
	AND b."kind" = 'role'
	AND b."award_category" IS NULL
	AND b."role_key" = v.role_key
	AND b."detail" = v.detail;
