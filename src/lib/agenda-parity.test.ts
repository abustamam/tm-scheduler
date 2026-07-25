// Print ⇄ deck parity for the per-club run-of-show (#367).
//
// The spec's central claim is that the printed run sheet and the projected deck
// adapt to a club's roles BY CONSTRUCTION, because both read the same signal —
// slot existence. Adaptation therefore cannot diverge. ORDERING still can, and
// this suite is what makes that fail in CI instead of on a projector
// mid-meeting.
//
// It compares an ordered sequence of SHARED SECTION IDENTITIES: each run-sheet
// beat and each deck slide is mapped to a `Section` (or explicitly excluded),
// and the two sequences must be equal for every point of the
// `geIntroducesFunctionaries` × role-set matrix.

import { describe, expect, it } from "vitest";
import type { AgendaSlot, RunOfShowConfig } from "./agenda-runsheet";
import { buildRunOfShow, expandRunSheet } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
	type Slide,
} from "./agenda-slides";

/** A segment of the meeting that BOTH renderings are expected to show. */
type Section =
	| "toastmasterOpens"
	| "functionaryIntro"
	| "speech"
	| "voteSpeaker"
	| "tableTopics"
	| "voteTableTopics"
	| "evaluation"
	| "voteEvaluator"
	| "evaluatorEvaluation"
	| "functionaryReports"
	| "generalEvaluation";

// ---------------------------------------------------------------------------
// The two mappings. Every beat and every slide kind is accounted for; the
// exclusions are listed BY NAME with the reason, never by a wildcard that would
// quietly swallow a future divergence.
// ---------------------------------------------------------------------------

/**
 * Section identity of each beat `buildRunOfShow` emits, IN ORDER (beats 1–15 of
 * the spec's table). `detail` pins each entry to the actual beat, so a reworded
 * or reordered template fails here with a readable diff instead of silently
 * mislabelling a section.
 */
const BEATS: { detail: string; section: Section | null }[] = [
	// Beat 1 — Sergeant-at-Arms, Call to Order. A room-logistics event beat with
	// no counterpart in the deck: nothing is projected while phones go silent.
	{ detail: "Call to Order · phones silent, exits noted", section: null },
	// Beat 2 — President's opening remarks. Likewise an event beat with no slide.
	{ detail: "Opening remarks; welcomes guests", section: null },
	{
		detail: "Opens meeting · introduces the theme",
		section: "toastmasterOpens",
	},
	{
		detail: "Introduces the {roles}; each explains their role",
		section: "functionaryIntro",
	},
	{ detail: "Prepared speech", section: "speech" },
	{ detail: "Timer's report · vote Best Speaker", section: "voteSpeaker" },
	{
		detail: "Impromptu topics using the Word of the Day",
		section: "tableTopics",
	},
	{
		detail: "Timer's report · vote Best Table Topics",
		section: "voteTableTopics",
	},
	{ detail: "Evaluates a speaker", section: "evaluation" },
	{ detail: "Timer's report · vote Best Evaluator", section: "voteEvaluator" },
	{ detail: "Evaluates the evaluators", section: "evaluatorEvaluation" },
	{
		detail: "Calls for the functionary reports",
		section: "functionaryReports",
	},
	{ detail: "Overall meeting evaluation", section: "generalEvaluation" },
	// Beat 14 — the Toastmaster's awards handout. Excluded because the deck's
	// `awards` slide is gated on WHICH SCORED SECTIONS EXIST (it lists only the
	// categories the meeting actually ran) while the print beat is a fixed
	// closing event. That is a content difference, not a section-ordering one.
	{ detail: "Awards · Best Table Topic, Evaluator & Speaker", section: null },
	// Beat 15 — President's club business / adjourn. Event beat, no slide.
	{ detail: "Club business · elections · adjourn", section: null },
];

/**
 * Section identity of each deck slide kind. `satisfies` makes this exhaustive:
 * adding a `Slide` kind without classifying it is a compile error.
 */
const SECTION_BY_SLIDE = {
	// --- Excluded, by name, with the reason ---
	// Deck chrome: the club-identity splash. No beat — the run sheet's first row
	// is the Call to Order.
	title: null,
	// Theme + Word of the Day. Gated on MEETING CONTENT (theme/word set), not on
	// which roles the club runs, so it has no beat of its own; beat 3 is the
	// Toastmaster opening, which maps to the `toastmaster` slide below.
	toastmasterIntro: null,
	// The standalone Word-of-the-Day slide. Content-gated like the above (needs a
	// definition or example). #354 may move it; deliberately not compared.
	wordOfDay: null,
	// Content-gated on which scored sections exist — see beat 14 above.
	awards: null,
	// Free-text per-meeting announcements (#349). No beat.
	reminders: null,
	// Deck chrome: the closing splash. No beat.
	thankYou: null,
	// --- Compared ---
	toastmaster: "toastmasterOpens",
	functionaryIntro: "functionaryIntro",
	speech: "speech",
	voteSpeaker: "voteSpeaker",
	tableTopics: "tableTopics",
	voteTableTopics: "voteTableTopics",
	evaluation: "evaluation",
	voteEvaluator: "voteEvaluator",
	evaluatorEvaluation: "evaluatorEvaluation",
	functionaryReports: "functionaryReports",
	generalEvaluation: "generalEvaluation",
} satisfies Record<Slide["kind"], Section | null>;

// ---------------------------------------------------------------------------
// Sequence extraction
// ---------------------------------------------------------------------------

/**
 * Collapse runs of the same section. The two renderings differ in MULTIPLICITY
 * by design — the run sheet emits one row per matching slot for a role beat
 * (two speakers ⇒ two rows), the deck emits one slide per speech but a single
 * vote/intro slide — so parity is about the ordered set of sections, not their
 * counts. Consecutive (not global) dedupe, so a section reappearing later in
 * only one of the two still fails.
 */
function dedupeConsecutive(xs: string[]): string[] {
	return xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
}

/**
 * The printed run sheet's section sequence.
 *
 * `expandRunSheet` processes each beat independently, so expanding one beat at
 * a time recovers which beat produced which rows — an identity `AgendaRow` does
 * not carry. The "harness" test below asserts that equivalence rather than
 * assuming it.
 */
function printSections(slots: AgendaSlot[], config: RunOfShowConfig): string[] {
	const template = buildRunOfShow(config);
	const out: string[] = [];
	template.forEach((beat, i) => {
		const section = BEATS[i]?.section;
		if (section && expandRunSheet(slots, [beat]).length > 0) out.push(section);
	});
	return dedupeConsecutive(out);
}

/** The projected deck's section sequence. */
function deckSections(slots: AgendaSlot[], config: RunOfShowConfig): string[] {
	const deck = buildSlideDeck({ meeting, club, slots, ...config });
	const out: string[] = [];
	for (const slide of deck) {
		// A kind absent from the map is surfaced in the diff rather than thrown,
		// so one red run shows every divergence at once. `satisfies` above is the
		// real guard; this is for readability.
		if (!(slide.kind in SECTION_BY_SLIDE)) {
			out.push(`unmapped:${slide.kind}`);
			continue;
		}
		const section = (SECTION_BY_SLIDE as Record<string, Section | null>)[
			slide.kind
		];
		if (section) out.push(section);
	}
	return dedupeConsecutive(out);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
		roleKey: "timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

// A meeting with theme, Word of the Day and announcements set, so the
// content-gated slides ARE in the deck and the exclusions above are proven not
// to disturb the ordering.
const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-06-25T23:45:00Z"),
	theme: "A Fresh Start",
	wordOfTheDay: "Momentum",
	wodDefinition: "impetus gained by a moving object",
	wodExample: "The momentum of the river keeps moving forward.",
	reminders: "Choose a learning path.",
};

const club: ClubForDeck = {
	name: "Parity Toastmasters",
	clubNumber: "1234567",
	district: "District 39",
	timezone: "America/Chicago",
	meetingSchedule: "2nd & 4th Thursday",
};

const tmod = slot({
	id: "tm",
	roleKey: "toastmaster_of_the_day",
	roleName: "Toastmaster of the Day",
	category: "leadership",
	assigneeName: "Schinthia",
});
const ttm = slot({
	id: "tt",
	roleKey: "table_topics_master",
	roleName: "Table Topics Master",
	category: "leadership",
	assigneeName: "Rasheed",
});
const ge = slot({
	id: "ge",
	roleKey: "general_evaluator",
	roleName: "General Evaluator",
	category: "leadership",
	assigneeName: "Saiful",
});
const speaker1 = slot({
	id: "sp1",
	roleKey: "speaker",
	roleName: "Speaker",
	category: "speaker",
	isSpeakerRole: true,
	slotIndex: 0,
	assigneeName: "Rehanna",
	minMinutes: 5,
	maxMinutes: 7,
});
const speaker2 = slot({
	id: "sp2",
	roleKey: "speaker",
	roleName: "Speaker",
	category: "speaker",
	isSpeakerRole: true,
	slotIndex: 1,
	assigneeName: "Sudheer",
	minMinutes: 5,
	maxMinutes: 7,
});
const evaluator1 = slot({
	id: "ev1",
	roleKey: "evaluator",
	roleName: "Evaluator",
	category: "evaluator",
	slotIndex: 0,
	assigneeName: "Faisal",
	evaluatesSlotId: "sp1",
	evaluates: { speakerName: "Rehanna" },
});
const evaluator2 = slot({
	id: "ev2",
	roleKey: "evaluator",
	roleName: "Evaluator",
	category: "evaluator",
	slotIndex: 1,
	assigneeName: "Priya",
	evaluatesSlotId: "sp2",
	evaluates: { speakerName: "Sudheer" },
});
const timer = slot({ id: "ti", assigneeName: "Bilal" });
const ahCounter = slot({
	id: "ah",
	roleKey: "ah_counter",
	roleName: "Ah-Counter",
	assigneeName: "Mona",
});
const grammarian = slot({
	id: "gr",
	roleKey: "grammarian",
	roleName: "Grammarian",
	assigneeName: "Gina",
});
const voteCounter = slot({
	id: "vc",
	roleKey: "vote_counter",
	roleName: "Vote Counter",
	assigneeName: "Omar",
});

/** Every standard role a club can run — the full nine-role club. */
const FULL: AgendaSlot[] = [
	tmod,
	ttm,
	ge,
	speaker1,
	speaker2,
	evaluator1,
	evaluator2,
	timer,
	ahCounter,
	grammarian,
	voteCounter,
];

const without = (...ids: string[]) => FULL.filter((s) => !ids.includes(s.id));

const CASES: { name: string; slots: AgendaSlot[] }[] = [
	{ name: "full nine-role club", slots: FULL },
	{
		name: "skeleton crew (Toastmaster, Speaker, Evaluator, Table Topics Master)",
		slots: [tmod, speaker1, evaluator1, ttm],
	},
	{ name: "no General Evaluator", slots: without("ge") },
	{ name: "no Timer", slots: without("ti") },
	{
		name: "no functionaries at all",
		slots: without("ti", "ah", "gr", "vc"),
	},
	{
		name: "functionaries but no General Evaluator",
		slots: without("ge", "ah", "vc"),
	},
	{
		name: "General Evaluator but no evaluators",
		slots: without("ev1", "ev2"),
	},
	{ name: "no Toastmaster of the Day", slots: without("tm") },
	{ name: "no speakers", slots: without("sp1", "sp2") },
	{ name: "no Table Topics Master", slots: without("tt") },
	{
		name: "functionaries only (no leadership roles at all)",
		slots: [timer, grammarian],
	},
	{ name: "no slots at all", slots: [] },
	{
		// A club-invented role flagged as a speaker role but carrying no standard
		// `speaker` key: it binds to no beat, so it must project no slide either.
		name: "custom speaker-category role with no standard key",
		slots: [
			tmod,
			grammarian,
			slot({
				id: "cus",
				roleKey: null,
				roleName: "Ice Breaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: "Nadia",
			}),
		],
	},
	{
		// Renaming a role never changes its key (#368), so both renderings must
		// keep binding it to the same section.
		name: "renamed standard roles (keys intact)",
		slots: [
			{ ...tmod, roleName: "Master of Ceremonies" },
			{ ...ge, roleName: "Chief Evaluator" },
			{ ...grammarian, roleName: "Wordsmith" },
			speaker1,
			evaluator1,
		],
	},
];

const CONFIGS: RunOfShowConfig[] = [
	{ geIntroducesFunctionaries: false },
	{ geIntroducesFunctionaries: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run-sheet ⇄ deck parity harness", () => {
	it("maps every beat of the template, in order, for both club configs", () => {
		for (const config of CONFIGS) {
			const template = buildRunOfShow(config);
			expect(template).toHaveLength(BEATS.length);
			expect(template.map((b) => b.detail)).toEqual(BEATS.map((b) => b.detail));
		}
	});

	it("expanding beats one at a time equals expanding the whole template", () => {
		for (const { slots } of CASES) {
			for (const config of CONFIGS) {
				const template = buildRunOfShow(config);
				expect(template.flatMap((b) => expandRunSheet(slots, [b]))).toEqual(
					expandRunSheet(slots, template),
				);
			}
		}
	});
});

describe("run-sheet ⇄ deck section-order parity (#367)", () => {
	for (const { name, slots } of CASES) {
		for (const config of CONFIGS) {
			const flag = config.geIntroducesFunctionaries
				? "MCF variant"
				: "standard";
			it(`${name} — ${flag}`, () => {
				expect(deckSections(slots, config)).toEqual(
					printSections(slots, config),
				);
			});
		}
	}

	it("the full nine-role club runs the whole spec'd sequence, in order", () => {
		// Pins the shared order absolutely, so the matrix above cannot pass by
		// both sides being wrong in the same way.
		const expected: Section[] = [
			"toastmasterOpens",
			"functionaryIntro",
			"speech",
			"voteSpeaker",
			"tableTopics",
			"voteTableTopics",
			"evaluation",
			"voteEvaluator",
			"evaluatorEvaluation",
			"functionaryReports",
			"generalEvaluation",
		];
		for (const config of CONFIGS) {
			expect(printSections(FULL, config)).toEqual(expected);
			expect(deckSections(FULL, config)).toEqual(expected);
		}
	});
});
