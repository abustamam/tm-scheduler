/**
 * The 9 standard Toastmasters meeting roles seeded into a brand-new club's
 * `role_definitions` — a club is non-functional without them. Kept as a pure,
 * db-free constant so it can be shared by BOTH the dev seed (`src/db/seed.ts`)
 * and the superadmin onboarding console (`onboarding-logic.ts`, #182) without
 * duplicating role strings or pulling the self-executing seed script into the
 * server bundle.
 *
 * The agenda importer (`scripts/import-agendas-logic.ts`) also reads Vote
 * Counter from here when backfilling a club that predates it, so the seeded
 * row and the backfilled row are byte-identical.
 */
export type RoleSeed = {
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	isSpeakerRole: boolean;
	description: string;
	/** Stable, rename-proof identity for this standard role (#368) — snake_case
	 *  of the canonical name. See `role_definitions.key` in `src/db/schema.ts`. */
	key: string;
	/**
	 * The role's guide (#933): what to do BEFORE the meeting, and what to do
	 * DURING it. One step per line — the surfaces render line breaks. Original
	 * prose, not adapted TI role material (ADR-0024), and written to agree with
	 * the run-of-show the printed agenda and the deck encode
	 * (`agenda-runsheet.ts`): who introduces whom, and which leader calls for
	 * the Timer's three reports (#444 is what a disagreement costs).
	 *
	 * DUPLICATED, deliberately, as the backfill in the migration that added the
	 * columns — a migration is frozen SQL and cannot import this file.
	 * `src/lib/role-guide.test.ts` holds the two together.
	 */
	beforeNotes: string;
	duringNotes: string;
};

export const ROLE_TEMPLATE: RoleSeed[] = [
	{
		name: "Toastmaster of the Day",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
		description:
			"Hosts the meeting: sets the theme, introduces each speaker and segment, and keeps energy and timing on track. Prep: review the agenda beforehand.",
		key: "toastmaster_of_the_day",
		beforeNotes:
			"Choose a theme and add it to the meeting page, so the Grammarian can pick a Word of the Day to match.\nA few days out, check the agenda: every role filled, and each speaker's title and time known.\nWrite a short introduction for each speaker, and plan how you'll tie the segments to your theme.",
		duringNotes:
			"Open the meeting and introduce the theme.\nIntroduce the functionaries, who each explain their role.\nIntroduce each speaker, and before each speech ask their evaluator for the speech objectives and timing.\nAfter the speeches, call for the Timer's report, open voting for Best Speaker and introduce the Table Topics Master.\nWhen the General Evaluator hands back, present the awards and hand over to the President.",
	},
	{
		name: "Table Topics Master",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 20,
		isSpeakerRole: false,
		description:
			"Leads the impromptu speaking segment by preparing 8–10 questions or scenarios and calling on members or guests to respond on the spot, then hands the meeting back over.",
		key: "table_topics_master",
		beforeNotes:
			"Ask the Toastmaster for the theme and the Grammarian for the Word of the Day.\nPrepare 8–10 short questions or scenarios anyone could answer on the spot, plus a few spares.\nPlan to call first on members without another speaking role, and on guests only if they're happy to try.",
		duringNotes:
			"When the Toastmaster introduces you, explain how Table Topics works and ask the Timer to explain the timing.\nRead each question before naming who answers it, and encourage speakers to use the Word of the Day.\nWhen the topics are done, call for the Timer's report and open voting for Best Table Topics.\nIntroduce the General Evaluator.",
	},
	{
		name: "Speaker",
		category: "speaker",
		defaultCount: 3,
		sortOrder: 30,
		isSpeakerRole: true,
		description:
			"Delivers a prepared speech from your Pathways project; coordinate with your evaluator on the project objectives and time target before the meeting.",
		key: "speaker",
		beforeNotes:
			"Choose your Pathways project and prepare your speech to its objectives and time.\nAdd your speech title and project on the meeting page.\nTell your evaluator the objectives, your time, and anything you'd like feedback on.\nRehearse out loud, with a timer, at least once.",
		duringNotes:
			"Arrive early to check the room, the lectern and any slides.\nWhen the Toastmaster introduces you, give your speech and keep an eye on the Timer's signals.\nListen to your evaluation, and note one thing to work on next time.",
	},
	{
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 3,
		sortOrder: 40,
		isSpeakerRole: false,
		description:
			"Provides structured written and verbal feedback on your assigned speaker's delivery, language, and achievement of their project goals.",
		key: "evaluator",
		beforeNotes:
			"Find out who you're evaluating, and ask them for their project, its objectives, their time, and anything they'd like you to focus on.\nRead the project's evaluation criteria so you know what to watch for.",
		duringNotes:
			"When the Toastmaster asks, share your speaker's objectives and timing with the room.\nDuring the speech, note what worked, one or two things to improve, and a specific suggestion for each.\nWhen the General Evaluator introduces you, give your evaluation within your time, opening and closing with strengths.\nGive your written notes to the speaker afterwards.",
	},
	{
		// Leadership, not evaluator: the GE runs the evaluation team rather than
		// evaluating a speech. Category drives the agenda-screen section grouping
		// and Best Evaluator award eligibility (the GE is not a candidate).
		name: "General Evaluator",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 50,
		isSpeakerRole: false,
		description:
			"Oversees meeting quality by evaluating all roles (except speakers) and summarizing feedback from the Timer, Ah-Counter, and Grammarian; introduces the speech evaluators.",
		key: "general_evaluator",
		beforeNotes:
			"Check that the Timer, Ah-Counter and Grammarian are confirmed and know they'll report to you.\nMake sure every speaker has an evaluator.\nDecide what you'll watch across the whole meeting: timing, hand-offs, preparation and the room's energy.",
		duringNotes:
			"Take notes on the whole meeting, from the opening onwards.\nWhen the Table Topics Master introduces you, introduce the speech evaluators and ask the Timer to explain the timing for an evaluation.\nAfter the evaluations, call for the Timer's report and open voting for Best Evaluator.\nEvaluate the evaluators, call for the functionaries' reports, give your overall evaluation of the meeting and hand back to the Toastmaster.",
	},
	{
		name: "Timer",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 60,
		isSpeakerRole: false,
		description:
			"Tracks and displays time signals for every speaker and evaluator, and presents a report whenever the meeting leader calls for one.",
		key: "timer",
		beforeNotes:
			"Check the agenda for each speaker's time, and the times for Table Topics and evaluations.\nBring a way to show green, yellow and red signals, and something to time with.",
		duringNotes:
			"When the functionaries are introduced, explain the timing signals.\nTime every speaker, Table Topics speaker and evaluator, show the signals and record each time.\nGive your report when the Toastmaster, the Table Topics Master and the General Evaluator each call for it.",
	},
	{
		name: "Ah-Counter",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 70,
		isSpeakerRole: false,
		description:
			"Tallies filler words (um, ah, so, you know, like) for each speaker during the meeting and reports the counts in the evaluation segment.",
		key: "ah_counter",
		beforeNotes:
			"Decide which filler words and sounds you'll count, such as um, ah, so and you know.\nBring a way to keep a tally for each person who speaks.",
		duringNotes:
			"When the functionaries are introduced, explain what you'll be listening for.\nTally filler words for everyone who speaks, not just the prepared speakers.\nGive your report when the General Evaluator calls for it.",
	},
	{
		name: "Grammarian",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 80,
		isSpeakerRole: false,
		description:
			"Introduces a Word of the Day, monitors language use throughout the meeting, and commends creative phrasing while noting grammatical slips in the evaluation segment.",
		key: "grammarian",
		beforeNotes:
			"Choose a Word of the Day that suits the theme and add it to the meeting page.\nPrepare its meaning and an example sentence, and a way to show it to the room.",
		duringNotes:
			"When the functionaries are introduced, give the Word of the Day and what it means.\nListen for good use of language, uses of the Word of the Day, and slips worth mentioning.\nGive your report when the General Evaluator calls for it.",
	},
	{
		name: "Vote Counter",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 90,
		isSpeakerRole: false,
		description:
			"Distributes and collects ballots for Best Speaker, Best Evaluator, and Best Table Topics, tallies the votes discreetly, and hands the results to the Toastmaster before the awards are announced.",
		key: "vote_counter",
		beforeNotes:
			"Check whether this meeting votes on paper or digitally.\nFor paper, bring ballots for Best Speaker, Best Evaluator and Best Table Topics, and something to collect them in.",
		duringNotes:
			"When voting opens after each segment, hand out and collect the ballots.\nCount the votes discreetly.\nHand the results to the Toastmaster before the awards.",
	},
];

/** Look up a stock role by name — throws if the template no longer defines it. */
export function roleSeed(name: string): RoleSeed {
	const seed = ROLE_TEMPLATE.find((r) => r.name === name);
	if (!seed) throw new Error(`No stock role definition named "${name}"`);
	return seed;
}
