/**
 * The seeded global Speech Contest template: a club contest's role set and
 * run-of-show, as DATA. Kept db-free beside `role-template.ts` so both the dev
 * seed and the production seeding script share one copy.
 *
 * Segment labels are deliberately GENERIC rather than the Toastmasters
 * International contest names (ADR-0024's trademark-safe default, #384). A club
 * wanting the official wording renames its materialized roles.
 *
 * TWO THINGS HERE ARE LOAD-BEARING and were decided after review:
 *
 * 1. THREE contestant roles, not one. Each contest segment gets its own role
 *    (`contestant_prepared` / `contestant_impromptu` / `contestant_evaluation`)
 *    with its own repeat key. With a single shared role there is one
 *    `role_definitions` row and one set of slots, so a member entered only in
 *    the impromptu contest would print in all three segments and have their
 *    minutes booked three times.
 *
 * 2. `contestant_prepared` sorts BEFORE `test_speaker`.
 *    `pickSpeakerAndEvaluatorRoles` (`meeting-roles.ts:198`) takes the lowest
 *    `sortOrder` among `isSpeakerRole` defs, and that role is what "+ Add
 *    speaker" adds. With `test_speaker` first, the button would add a second
 *    Test Speaker and there would be no way to change the contestant count.
 *
 * Contestant roles are SPEAKER-category: a contest speech is still a speech, so
 * the speech record, the project picker and Pathways attribution all work
 * against a contestant slot with no special-casing.
 */
import type { TemplateBeatRow, TemplateRoleRow } from "./agenda-template-rows";

export const CONTEST_TEMPLATE_KEY = "speech_contest";

type SeedRole = TemplateRoleRow & {
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	description: string;
};

export type TemplateSeed = {
	key: string;
	name: string;
	description: string;
	defaultLengthMinutes: number;
	roles: SeedRole[];
	beats: TemplateBeatRow[];
};

const role = (
	key: string,
	name: string,
	category: SeedRole["category"],
	defaultCount: number,
	sortOrder: number,
	description: string,
	isSpeakerRole = false,
): SeedRole => ({
	key,
	name,
	category,
	defaultCount,
	sortOrder,
	description,
	isSpeakerRole,
});

let order = 0;
const beat = (
	over: Partial<TemplateBeatRow> & {
		kind: TemplateBeatRow["kind"];
		label: string;
	},
): TemplateBeatRow => ({
	sortOrder: order++,
	detail: null,
	minutes: 0,
	roleKey: null,
	repeatsRoleKey: null,
	flex: false,
	markGreen: null,
	markYellow: null,
	markRed: null,
	...over,
});

export const CONTEST_TEMPLATE: TemplateSeed = {
	key: CONTEST_TEMPLATE_KEY,
	name: "Speech Contest",
	description:
		"A club contest: prepared speeches, impromptu speaking and speech evaluation, judged on paper ballots.",
	defaultLengthMinutes: 180,
	roles: [
		role(
			"sergeant_at_arms",
			"Sergeant at Arms",
			"leadership",
			1,
			10,
			"Opens the room, seats guests and calls the contest to order.",
		),
		role(
			"contest_chair",
			"Contest Chair",
			"leadership",
			1,
			20,
			"Runs the contest: welcomes the room, explains the rules, introduces each contestant and announces the results.",
		),
		role(
			"chief_judge",
			"Chief Judge",
			"leadership",
			1,
			30,
			"Briefs the judges, collects and verifies the ballots, and certifies the result. Recruited from outside the club where possible.",
		),
		role(
			"judge",
			"Judge",
			"functionary",
			5,
			40,
			"Scores each contestant against the contest criteria and submits a ballot.",
		),
		role(
			"ballot_counter",
			"Ballot Counter",
			"functionary",
			2,
			50,
			"Collects ballots and tallies them with the Chief Judge, out of the room.",
		),
		role(
			"contest_timer",
			"Contest Timer",
			"functionary",
			2,
			60,
			"Times each contestant and signals the qualifying window; two timers so the times can be cross-checked.",
		),
		// 70 — BEFORE test_speaker, so "+ Add speaker" adds a contestant.
		role(
			"contestant_prepared",
			"Prepared Speech Contestant",
			"speaker",
			4,
			70,
			"Competes in the prepared speech contest. A contest speech can still be a Pathways project — attach it as you would any speech.",
			true,
		),
		role(
			"contestant_impromptu",
			"Impromptu Contestant",
			"speaker",
			4,
			75,
			"Competes in the impromptu speaking contest, answering a question none of the contestants has heard in advance.",
			true,
		),
		role(
			"contestant_evaluation",
			"Evaluation Contestant",
			"speaker",
			4,
			80,
			"Competes in the speech evaluation contest, evaluating the test speech.",
			true,
		),
		role(
			"test_speaker",
			"Test Speaker",
			"speaker",
			1,
			90,
			"Delivers the speech the evaluation contestants evaluate.",
			true,
		),
	],
	beats: [
		beat({ kind: "section", label: "OPENING" }),
		beat({
			kind: "role",
			label: "Call to order",
			roleKey: "sergeant_at_arms",
			minutes: 5,
			detail: "Opens the room and hands over to the Contest Chair.",
		}),
		beat({
			kind: "role",
			label: "Welcome and introductions",
			roleKey: "contest_chair",
			minutes: 5,
			detail: "Welcomes contestants, judges and guests.",
		}),
		beat({
			kind: "role",
			label: "Judges' briefing",
			roleKey: "chief_judge",
			minutes: 10,
			detail:
				"Briefs the judges and ballot counters, and confirms eligibility.",
		}),
		beat({
			kind: "role",
			label: "Contest rules and timing",
			roleKey: "contest_chair",
			minutes: 5,
			detail:
				"Explains the speaking area, the timing signals and the disqualification rules.",
		}),

		beat({ kind: "section", label: "PREPARED SPEECH CONTEST" }),
		beat({
			kind: "role",
			label: "Prepared speech",
			roleKey: "contestant_prepared",
			repeatsRoleKey: "contestant_prepared",
			minutes: 7,
			markGreen: 5,
			markYellow: 6,
			markRed: 7,
			detail: "Delivers the prepared speech.",
		}),
		beat({
			kind: "event",
			label: "One minute of silence",
			repeatsRoleKey: "contestant_prepared",
			minutes: 1,
			detail: "Judges complete their ballots.",
		}),
		beat({
			kind: "event",
			label: "Two minutes of silence",
			minutes: 2,
			detail: "After the final contestant, judges finish their ballots.",
		}),
		beat({
			kind: "role",
			label: "Contestant interviews",
			roleKey: "contest_chair",
			minutes: 5,
			detail: "Brief interviews while the ballots are collected.",
		}),

		beat({ kind: "section", label: "IMPROMPTU SPEAKING CONTEST" }),
		beat({
			kind: "role",
			label: "Impromptu contest briefing",
			roleKey: "contest_chair",
			minutes: 3,
			detail: "Explains the impromptu format and the question.",
		}),
		beat({
			kind: "role",
			label: "Impromptu answer",
			roleKey: "contestant_impromptu",
			repeatsRoleKey: "contestant_impromptu",
			minutes: 2,
			markGreen: 1,
			markYellow: 1.5,
			markRed: 2,
			detail: "Answers the question.",
		}),
		beat({
			kind: "event",
			label: "One minute of silence",
			repeatsRoleKey: "contestant_impromptu",
			minutes: 1,
			detail: "Judges complete their ballots.",
		}),
		beat({
			kind: "event",
			label: "Break",
			minutes: 10,
			detail: "Ballots are tallied.",
		}),

		beat({ kind: "section", label: "SPEECH EVALUATION CONTEST" }),
		beat({
			kind: "role",
			label: "Evaluation contest briefing",
			roleKey: "contest_chair",
			minutes: 3,
			detail: "Explains the evaluation format.",
		}),
		beat({
			kind: "role",
			label: "Test speech",
			roleKey: "test_speaker",
			minutes: 7,
			detail: "The speech every evaluation contestant evaluates.",
		}),
		beat({
			kind: "event",
			label: "Evaluation preparation",
			minutes: 5,
			detail: "Contestants prepare their evaluations out of the room.",
		}),
		beat({
			kind: "role",
			label: "Speech evaluation",
			roleKey: "contestant_evaluation",
			repeatsRoleKey: "contestant_evaluation",
			minutes: 3,
			markGreen: 2,
			markYellow: 2.5,
			markRed: 3,
			detail: "Delivers the evaluation.",
		}),
		beat({
			kind: "event",
			label: "One minute of silence",
			repeatsRoleKey: "contestant_evaluation",
			minutes: 1,
			detail: "Judges complete their ballots.",
		}),

		beat({ kind: "section", label: "RESULTS AND CLOSING" }),
		beat({
			kind: "role",
			label: "Tallying",
			roleKey: "ballot_counter",
			minutes: 10,
			detail: "Ballots are counted and verified with the Chief Judge.",
		}),
		beat({
			kind: "role",
			label: "Timers' report",
			roleKey: "contest_timer",
			minutes: 3,
			detail: "Reports each contestant's time and confirms who qualified.",
		}),
		beat({
			kind: "role",
			label: "Results and certificates",
			roleKey: "contest_chair",
			minutes: 10,
			detail: "Announces the winners and presents the certificates.",
		}),
		beat({
			kind: "role",
			label: "Closing remarks",
			roleKey: "contest_chair",
			minutes: 5,
			detail: "Thanks the judges, the organizing team and the guests.",
		}),
	],
};
