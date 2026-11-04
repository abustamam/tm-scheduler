-- #1471: clubs with geIntroducesFunctionaries ON get the General-Evaluator variant of the
-- Toastmaster / General Evaluator "during" guide, only where it still equals the standard seed.
-- Text is copied from ROLE_TEMPLATE; the "GE-variant guide migration parity" test in src/lib/role-guide.test.ts holds the two together.
UPDATE "role_definitions" rd SET "during_notes" = 'Open the meeting and introduce the theme.
Introduce the General Evaluator, who introduces the functionaries and hands back.
Introduce each speaker, and before each speech ask their evaluator for the speech objectives and timing.
After the speeches, call for the Timer''s report, open voting for Best Speaker and introduce the Table Topics Master.
When the General Evaluator hands back, present the awards and hand over to the President.' FROM "clubs" c WHERE rd."club_id" = c."id" AND c."ge_introduces_functionaries" = true AND rd."key" = 'toastmaster_of_the_day' AND btrim(rd."during_notes", E' \t\r\n') = 'Open the meeting and introduce the theme.
Introduce the functionaries, who each explain their role.
Introduce each speaker, and before each speech ask their evaluator for the speech objectives and timing.
After the speeches, call for the Timer''s report, open voting for Best Speaker and introduce the Table Topics Master.
When the General Evaluator hands back, present the awards and hand over to the President.';
UPDATE "role_definitions" rd SET "during_notes" = 'Take notes on the whole meeting, from the opening onwards.
When the Toastmaster hands over at the opening, introduce the functionaries, who each explain their role, then hand back.
When the Table Topics Master introduces you, introduce the speech evaluators and ask the Timer to explain the timing for an evaluation.
After the evaluations, call for the Timer''s report and open voting for Best Evaluator.
Evaluate the evaluators, call for the functionaries'' reports, give your overall evaluation of the meeting and hand back to the Toastmaster.' FROM "clubs" c WHERE rd."club_id" = c."id" AND c."ge_introduces_functionaries" = true AND rd."key" = 'general_evaluator' AND btrim(rd."during_notes", E' \t\r\n') = 'Take notes on the whole meeting, from the opening onwards.
When the Table Topics Master introduces you, introduce the speech evaluators and ask the Timer to explain the timing for an evaluation.
After the evaluations, call for the Timer''s report and open voting for Best Evaluator.
Evaluate the evaluators, call for the functionaries'' reports, give your overall evaluation of the meeting and hand back to the Toastmaster.';
