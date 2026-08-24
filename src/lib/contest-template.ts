/**
 * The seeded global speech contest template: a club contest's role set and
 * run-of-show, as DATA. Kept db-free beside `role-template.ts` so both the dev
 * seed and the production seeding script share one copy.
 *
 * Segment labels are deliberately GENERIC rather than the Toastmasters
 * International contest names (ADR-0024's trademark-safe default, #384). A club
 * wanting the official wording renames its materialized roles.
 *
 * ONE CONTEST, NOT THREE. This shipped covering prepared speeches, impromptu
 * speaking and speech evaluation as three sequential segments, and that was
 * wrong in a way worth recording, because the storage cannot express the fix.
 * A club running only one of the three had no way to remove the other two:
 * deleting the contestant slots collapses their repeat blocks, but the section
 * bands, the chair's briefings, the break and the evaluation-prep window bind
 * to no contestant role, so nothing an officer could do reached them. A
 * prepared-speeches-only club still printed two phantom segments and 28
 * minutes of a contest that was not happening. Templates get no gating by
 * design (Phase 1 spec D1), so a template must describe an event that actually
 * happens rather than a menu of every event it could be.
 *
 * If a future template really does run two contests in one night, each needs
 * its OWN contestant role with its own repeat key — with a single shared role
 * there is one `role_definitions` row and one set of slots, so a member entered
 * in only one contest prints in both segments with their minutes booked twice.
 * That constraint is why the original had three roles; it was the right answer
 * to the wrong question.
 *
 * `contestant_prepared` is now the ONLY `isSpeakerRole` def in the template,
 * which is what makes the agenda's +/- speaker controls work:
 * `pickSpeakerAndEvaluatorRoles` (`meeting-roles.ts:198`) takes the lowest
 * `sortOrder` among speaker defs, so with several contestant roles those
 * controls could only ever reach the first one and the rest were fixed at
 * whatever `defaultCount` said.
 *
 * Contestant roles are SPEAKER-category: a contest speech is still a speech, so
 * the speech record, the project picker and Pathways attribution all work
 * against a contestant slot with no special-casing.
 */
import type { TemplateBeatSeed, TemplateRoleRow } from "./agenda-template-rows";

/**
 * Unchanged across the rewrite, on purpose. `seedTemplate` is idempotent on this
 * key and REPLACES the template's roles and beats in place, so keeping it means
 * an already-seeded database (production included) is corrected by re-running
 * the seed rather than needing the old row retired — `meetings.template_id` is
 * `ON DELETE RESTRICT`, which makes deleting a template a real operation rather
 * than a cleanup.
 */
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
	beats: TemplateBeatSeed[];
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
	over: Partial<TemplateBeatSeed> & {
		kind: TemplateBeatSeed["kind"];
		label: string;
	},
): TemplateBeatSeed => ({
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
		"A club speech contest: prepared speeches judged on paper ballots. Add or remove contestants with the +/- controls on the agenda.",
	// 3 contestants: 25 opening + 24 speeches + 7 silence/interviews + 28 results
	// = 84. Rounded up, leaving room for a fourth contestant without re-editing.
	defaultLengthMinutes: 90,
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
			"Briefs the judges, verifies the ballots and certifies the result. Recruited from outside the club where possible.",
		),
		// Five is the usual panel. Judges own no beat, so this number costs no
		// agenda rows — it only decides how many claimable places the sign-up
		// sheet offers, and an unfilled one can be removed.
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
			"Collects the ballots and tallies them with the Chief Judge, out of the room.",
		),
		role(
			"contest_timer",
			"Contest Timer",
			"functionary",
			2,
			60,
			"Times each contestant and signals the qualifying window; two timers so the times can be cross-checked.",
		),
		// The template's ONLY speaker role — see the header note on +/- controls.
		// Three is a starting point, not a limit.
		role(
			"contestant_prepared",
			"Contestant",
			"speaker",
			3,
			70,
			"Competes in the contest. A contest speech can still be a Pathways project — attach it as you would any speech.",
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

		beat({ kind: "section", label: "SPEECHES" }),
		// One block per contestant slot: the speech, then the ballot minute. Add
		// or remove contestants and the agenda follows, which is the whole reason
		// this is a repeat block rather than a fixed number of rows.
		beat({
			kind: "role",
			label: "Contest speech",
			roleKey: "contestant_prepared",
			repeatsRoleKey: "contestant_prepared",
			minutes: 7,
			markGreen: 5,
			markYellow: 6,
			markRed: 7,
			detail: "Qualifying window 4:30-7:30.",
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

		beat({ kind: "section", label: "RESULTS AND CLOSING" }),
		beat({
			kind: "role",
			label: "Tallying",
			roleKey: "ballot_counter",
			minutes: 10,
			detail:
				"Ballots are counted and verified with the Chief Judge, out of the room.",
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
