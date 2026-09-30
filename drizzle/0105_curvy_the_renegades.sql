ALTER TABLE "role_definitions" ADD COLUMN "before_notes" text;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD COLUMN "during_notes" text;--> statement-breakpoint
-- #933 backfill: the standard roles' default guide text (ROLE_TEMPLATE in
-- src/lib/role-template.ts), matched by role key and written into NULL fields
-- ONLY, so a field a club has already written is never overwritten.
-- src/lib/role-guide.test.ts holds this text equal to ROLE_TEMPLATE.
UPDATE "role_definitions" SET "before_notes" = 'Choose a theme and add it to the meeting page, so the Grammarian can pick a Word of the Day to match.
A few days out, check the agenda: every role filled, and each speaker''s title and time known.
Write a short introduction for each speaker, and plan how you''ll tie the segments to your theme.' WHERE "key" = 'toastmaster_of_the_day' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'Open the meeting and introduce the theme.
Introduce the functionaries, who each explain their role.
Introduce each speaker, and before each speech ask their evaluator for the speech objectives and timing.
After the speeches, call for the Timer''s report, open voting for Best Speaker and introduce the Table Topics Master.
When the General Evaluator hands back, present the awards and hand over to the President.' WHERE "key" = 'toastmaster_of_the_day' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Ask the Toastmaster for the theme and the Grammarian for the Word of the Day.
Prepare 8–10 short questions or scenarios anyone could answer on the spot, plus a few spares.
Plan to call first on members without another speaking role, and on guests only if they''re happy to try.' WHERE "key" = 'table_topics_master' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'When the Toastmaster introduces you, explain how Table Topics works and ask the Timer to explain the timing.
Read each question before naming who answers it, and encourage speakers to use the Word of the Day.
When the topics are done, call for the Timer''s report and open voting for Best Table Topics.
Introduce the General Evaluator.' WHERE "key" = 'table_topics_master' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Choose your Pathways project and prepare your speech to its objectives and time.
Add your speech title and project on the meeting page.
Tell your evaluator the objectives, your time, and anything you''d like feedback on.
Rehearse out loud, with a timer, at least once.' WHERE "key" = 'speaker' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'Arrive early to check the room, the lectern and any slides.
When the Toastmaster introduces you, give your speech and keep an eye on the Timer''s signals.
Listen to your evaluation, and note one thing to work on next time.' WHERE "key" = 'speaker' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Find out who you''re evaluating, and ask them for their project, its objectives, their time, and anything they''d like you to focus on.
Read the project''s evaluation criteria so you know what to watch for.' WHERE "key" = 'evaluator' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'When the Toastmaster asks, share your speaker''s objectives and timing with the room.
During the speech, note what worked, one or two things to improve, and a specific suggestion for each.
When the General Evaluator introduces you, give your evaluation within your time, opening and closing with strengths.
Give your written notes to the speaker afterwards.' WHERE "key" = 'evaluator' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Check that the Timer, Ah-Counter and Grammarian are confirmed and know they''ll report to you.
Make sure every speaker has an evaluator.
Decide what you''ll watch across the whole meeting: timing, hand-offs, preparation and the room''s energy.' WHERE "key" = 'general_evaluator' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'Take notes on the whole meeting, from the opening onwards.
When the Table Topics Master introduces you, introduce the speech evaluators and ask the Timer to explain the timing for an evaluation.
After the evaluations, call for the Timer''s report and open voting for Best Evaluator.
Evaluate the evaluators, call for the functionaries'' reports, give your overall evaluation of the meeting and hand back to the Toastmaster.' WHERE "key" = 'general_evaluator' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Check the agenda for each speaker''s time, and the times for Table Topics and evaluations.
Bring a way to show green, yellow and red signals, and something to time with.' WHERE "key" = 'timer' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'When the functionaries are introduced, explain the timing signals.
Time every speaker, Table Topics speaker and evaluator, show the signals and record each time.
Give your report when the Toastmaster, the Table Topics Master and the General Evaluator each call for it.' WHERE "key" = 'timer' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Decide which filler words and sounds you''ll count, such as um, ah, so and you know.
Bring a way to keep a tally for each person who speaks.' WHERE "key" = 'ah_counter' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'When the functionaries are introduced, explain what you''ll be listening for.
Tally filler words for everyone who speaks, not just the prepared speakers.
Give your report when the General Evaluator calls for it.' WHERE "key" = 'ah_counter' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Choose a Word of the Day that suits the theme and add it to the meeting page.
Prepare its meaning and an example sentence, and a way to show it to the room.' WHERE "key" = 'grammarian' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'When the functionaries are introduced, give the Word of the Day and what it means.
Listen for good use of language, uses of the Word of the Day, and slips worth mentioning.
Give your report when the General Evaluator calls for it.' WHERE "key" = 'grammarian' AND "during_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "before_notes" = 'Check whether this meeting votes on paper or digitally.
For paper, bring ballots for Best Speaker, Best Evaluator and Best Table Topics, and something to collect them in.' WHERE "key" = 'vote_counter' AND "before_notes" IS NULL;--> statement-breakpoint
UPDATE "role_definitions" SET "during_notes" = 'When voting opens after each segment, hand out and collect the ballots.
Count the votes discreetly.
Hand the results to the Toastmaster before the awards.' WHERE "key" = 'vote_counter' AND "during_notes" IS NULL;
