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
import {
	buildRunOfShow,
	DEFAULT_SPEAKER_MINUTES,
	expandRunSheet,
	formatBeatMinutes,
} from "./agenda-runsheet";
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
	| "generalEvaluation"
	| "awards"
	| "guestComments";

// ---------------------------------------------------------------------------
// The two mappings. Every beat and every slide kind is accounted for; the
// exclusions are listed BY NAME with the reason, never by a wildcard that would
// quietly swallow a future divergence.
// ---------------------------------------------------------------------------

/**
 * A hand-off beat's section: none YET (#363). `buildSlideDeck` grows hand-off
 * slides in a later slice of the same issue, at which point these stop being
 * exclusions and become a compared section like any other. Until then they are
 * excluded exactly as every other slide-less beat is — named, with the reason —
 * and the run-sheet suite asserts their owner, gate and position directly.
 */
const HANDOFF: Section | null = null;

/**
 * Section identity of each beat `buildRunOfShow` emits, IN ORDER (the spec's
 * table, plus the guest-comments beat #352 inserts and the hand-off beats #363
 * inserts). `detail` pins each entry to the actual beat, so a reworded or
 * reordered template fails here with a readable diff instead of silently
 * mislabelling a section.
 */
const BEATS: { detail: string; section: Section | null }[] = [
	// Sergeant-at-Arms, Call to Order. A room-logistics event beat with
	// no counterpart in the deck: nothing is projected while phones go silent.
	{
		detail: "Call to Order · phones silent · introduces the President",
		section: null,
	},
	// President's opening remarks. Likewise an event beat with no slide.
	{ detail: "Opening remarks; welcomes guests", section: null },
	{
		detail: "Opens meeting · introduces the theme",
		section: "toastmasterOpens",
	},
	{
		detail: "Introduces the {roles}; each explains their role",
		section: "functionaryIntro",
	},
	{ detail: "Introduces the speakers", section: HANDOFF },
	{ detail: "Prepared speech", section: "speech" },
	{
		detail: "Calls for the Timer's report · opens voting for Best Speaker",
		section: "voteSpeaker",
	},
	{ detail: "Introduces the Table Topics Master", section: HANDOFF },
	{
		detail: "Impromptu topics using the Word of the Day",
		section: "tableTopics",
	},
	{
		detail: "Calls for the Timer's report · opens voting for Best Table Topics",
		section: "voteTableTopics",
	},
	{ detail: "Introduces the General Evaluator", section: HANDOFF },
	{ detail: "Introduces the speech evaluators", section: HANDOFF },
	{ detail: "Evaluates a speaker", section: "evaluation" },
	{
		detail: "Calls for the Timer's report · opens voting for Best Evaluator",
		section: "voteEvaluator",
	},
	{ detail: "Evaluates the evaluators", section: "evaluatorEvaluation" },
	{
		detail: "Calls for the functionary reports",
		section: "functionaryReports",
	},
	{
		detail: "Overall meeting evaluation · returns control to the Toastmaster",
		section: "generalEvaluation",
	},
	// The Toastmaster's awards handout. Compared as of #372: the beat
	// is now gated on the scored segments and names only those categories, which
	// is exactly how the deck's `awards` slide was already built, so the two are
	// comparable rather than a standing content difference.
	{
		detail: "Awards · {awards} · hands over to the President",
		section: "awards",
	},
	// Guest comments (#352), carved out of the President's closing so
	// they get a row to point at and minutes on the clock. Ungated, like the
	// opening remarks: every meeting can have guests, and the spec rules out a
	// per-club toggle. It is a SECTION, not an exclusion — #352 adds it to both
	// surfaces, so it has to be compared.
	{
		detail: "Guest Comments · invites our guests to share their thoughts",
		section: "guestComments",
	},
	// President's club business / adjourn. Event beat, no slide. It no
	// longer mentions guest comments: the beat above is the replacement the
	// clause was waiting for, and prompting for them twice is worse than once.
	{ detail: "Club business · announcements · adjourn", section: null },
];

/** The one beat only MCF's variant carries (#363): the Toastmaster introducing
 *  the General Evaluator before handing them the room for the functionary
 *  introductions. The standard flow has no early GE appearance. */
const GE_OPENING_INTRO_BEAT: { detail: string; section: Section | null } = {
	detail: "Introduces the General Evaluator",
	section: HANDOFF,
};

/** `BEATS`, for the variant in play: MCF's inserts the opening GE introduction
 *  directly BEFORE the functionary intro, which is where `buildRunOfShow` puts
 *  it — it introduces the person who then runs that beat. */
function beatsFor({ geIntroducesFunctionaries }: RunOfShowConfig) {
	if (!geIntroducesFunctionaries) return BEATS;
	const at = BEATS.findIndex((b) => b.section === "functionaryIntro");
	return [...BEATS.slice(0, at), GE_OPENING_INTRO_BEAT, ...BEATS.slice(at)];
}

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
	// which roles the club runs, so it has no beat of its own; the Toastmaster's
	// opening beat maps to the `toastmaster` slide below.
	toastmasterIntro: null,
	// The standalone Word-of-the-Day slide. #354 moved it out of the General
	// Evaluator's stretch and into the Toastmaster's opening, immediately after
	// `toastmasterIntro` — but it stays excluded for the reason it always was:
	// its gate is MEETING CONTENT (a word plus a definition or example), not
	// which roles the club runs, so no beat corresponds to it. The Grammarian it
	// now credits changes the slide's COPY, never whether it exists, so the
	// exclusion still holds after the move. What the run sheet does say about
	// the word is the functionary-intro beat's "each explains their role" and the
	// Table Topics beat's detail — neither is a Word-of-the-Day section of its
	// own.
	wordOfDay: null,
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
	// Gated on which scored segments exist — and so is the awards beat, as of
	// #372.
	awards: "awards",
	// Ungated on both surfaces (#352): every meeting can have guests.
	guestComments: "guestComments",
} satisfies Record<Slide["kind"], Section | null>;

/**
 * Deck slide kinds that project a DURATION, and the section — hence the beat —
 * whose budget that duration has to be (#356).
 *
 * Ordering parity alone let the two surfaces state different minutes for the
 * same beat, and they did: the speech-evaluation beat budgeted 3 minutes while
 * the deck's `EVALUATION_TIMING` said "2–3 minutes". Deriving the deck's
 * timings from the
 * beat makes that unrepresentable, and makes this assertion cheap — the check
 * is just "the slide says what its beat budgets", with no minute values
 * restated here to drift in their turn.
 *
 * `satisfies` keeps it exhaustive over the slides that carry a `time`: a new
 * timed slide has to be classified or this stops compiling. The `tableTopics`
 * slide is outside it by construction — its `timing` is a PER-SPEAKER limit,
 * not the segment budget the Table Topics beat books, so there is nothing to
 * compare.
 *
 * The exhaustiveness has a shape requirement worth knowing: `Extract<Slide,
 * { time: string }>` selects only slides whose duration is a REQUIRED `string`
 * under that exact key. A slide typed `time: string | null` or `time?: string`
 * — the natural shape for a duration shown only when known — is silently not
 * selected and compiles clean, as does any duration under a different property
 * name (which is how `tableTopics.timing` already sits outside). Adding one of
 * those reopens exactly the drift this file exists to catch, with the suite
 * still green. Give a new timed slide a required `time: string`, or widen this.
 */
const TIMED_SLIDES = {
	// The prepared-speech slide states the SLOT's range and the run sheet books
	// that slot for the same row, so there is no beat budget to compare against.
	// This exclusion is about SHAPE, not about the two surfaces being unchecked:
	// they ARE compared, slot-to-slot rather than slide-to-beat, by the
	// "speech-slot time agreement" suite at the bottom of this file (#394). That
	// is the assertion whose absence let the divergence ship — a slot with Min 5
	// and Max blank projected "Time: 5 minutes" while the timeline booked
	// `maxMinutes ?? DEFAULT_SPEAKER_MINUTES` = 7 for the same row, shifting
	// every later printed row's clock.
	speech: null,
	evaluation: "evaluation",
	evaluatorEvaluation: "evaluatorEvaluation",
	generalEvaluation: "generalEvaluation",
} satisfies Record<Extract<Slide, { time: string }>["kind"], Section | null>;

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
	const beats = beatsFor(config);
	const out: string[] = [];
	template.forEach((beat, i) => {
		const section = beats[i]?.section;
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
/** A role the club invented, marked `category: "functionary"` — it binds to no
 *  standard key, which is precisely the combination neither surface handled
 *  consistently before #371. */
const jokeMaster = slot({
	id: "jm",
	roleKey: null,
	roleName: "Joke Master",
	assigneeName: "Nadia",
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
		// #371: a club-invented functionary is a functionary. It used to appear on
		// the projected `functionaryIntro` slide (whose team came from
		// `buildLegend`, a category filter) but not in the printed
		// functionary-intro row (whose `{roles}` resolved against the four standard
		// keys) — a CONTENT
		// divergence this ordering test cannot see, which is why the run-sheet and
		// deck suites assert the lists directly. What it can see is the gate.
		name: "custom functionary-category role alongside the standard four",
		slots: [...FULL, jokeMaster],
	},
	{
		// The all-custom club: #368's disable lifecycle turns off all four standard
		// functionaries and the club runs its own. The functionary-intro and
		// functionary-reports beats used to vanish
		// from print AND deck together — consistent, and consistently wrong.
		name: "all-custom functionaries (standard four disabled)",
		slots: [tmod, ttm, ge, speaker1, evaluator1, jokeMaster],
	},
	{
		// The functionary-reports gate decision (#371): a Vote Counter is a
		// functionary, so they are INTRODUCED, but they give no report — so the
		// reports section is
		// absent from both surfaces.
		name: "Vote Counter is the club's only functionary",
		slots: [tmod, ttm, ge, speaker1, evaluator1, voteCounter],
	},
	{
		// An admin can change a role's category (`applyRoleDefinitionUpdate`), so a
		// standard KEY under a non-functionary category is reachable. The category
		// is the definition (#371), so this club runs no functionaries and both
		// surfaces must drop the functionary-intro and functionary-reports beats
		// together — the case where a key-based
		// gating fallback would have made print render a beat the deck omits.
		name: "standard functionary key recategorised out of the functionaries",
		slots: [
			tmod,
			ttm,
			ge,
			speaker1,
			evaluator1,
			{ ...timer, category: "leadership" },
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
			const beats = beatsFor(config);
			expect(template).toHaveLength(beats.length);
			expect(template.map((b) => b.detail)).toEqual(beats.map((b) => b.detail));
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
			"awards",
			"guestComments",
		];
		for (const config of CONFIGS) {
			expect(printSections(FULL, config)).toEqual(expected);
			expect(deckSections(FULL, config)).toEqual(expected);
		}
	});
});

describe("run-sheet ⇄ deck duration parity (#356)", () => {
	it("projects each timed beat's own budgeted duration", () => {
		for (const config of CONFIGS) {
			const template = buildRunOfShow(config);
			const deck = buildSlideDeck({ meeting, club, slots: FULL, ...config });
			const checked: Section[] = [];
			for (const slide of deck) {
				if (!("time" in slide)) continue;
				const section = TIMED_SLIDES[slide.kind];
				if (section == null) continue;
				const beat =
					template[beatsFor(config).findIndex((b) => b.section === section)];
				expect(slide.time).toBe(formatBeatMinutes(beat.minutes));
				checked.push(section);
			}
			// The matrix above proves the sections are all present; this proves the
			// loop actually reached every timed one rather than vacuously passing.
			expect([...new Set(checked)]).toEqual([
				"evaluation",
				"evaluatorEvaluation",
				"generalEvaluation",
			]);
		}
	});
});

// ---------------------------------------------------------------------------
// Speech-slot time agreement (#394)
// ---------------------------------------------------------------------------

/**
 * The prepared-speech row is the one place the two surfaces read a SLOT rather
 * than a beat, so `TIMED_SLIDES.speech` is excluded above — but that exclusion
 * is what let the deck and the run sheet disagree about the same speaker for
 * three releases. This pins the invariant directly: the upper bound the deck
 * projects and the duration the printed clock books are the same number, for
 * all four shapes a slot's Min/Max pair can take — INCLUDING the half-filled
 * ones already sitting in the database, which is the whole point, since they
 * are not being migrated.
 *
 * The four shapes do NOT all resolve the same way, and that is deliberate
 * (#394): the deck and the clock always agree with each other, but a max-only
 * slot keeps the max its club typed rather than being rounded up to the house
 * default. Two questions, two helpers — see `speech-window.ts`.
 */
const speechBeatIndex = (config: RunOfShowConfig) =>
	beatsFor(config).findIndex((b) => b.section === "speech");

/** The last number in a slide's "Time:" text: "4–6 minutes" ⇒ 6, "7 minutes" ⇒ 7. */
function projectedUpperBound(time: string): number {
	const nums = time.match(/\d+(?:\.\d+)?/g);
	if (nums == null) throw new Error(`no minutes in "${time}"`);
	return Number(nums[nums.length - 1]);
}

const WINDOW_CASES: {
	name: string;
	minMinutes: number | null;
	maxMinutes: number | null;
	/** What the deck projects, verbatim. */
	time: string;
	/** What the printed run sheet books for the row. */
	minutes: number;
	/** Whether the Timer gets green·amber·red marks. */
	marks: boolean;
}[] = [
	{
		name: "both ends set — the club's own range, on both surfaces",
		minMinutes: 4,
		maxMinutes: 6,
		time: "4–6 minutes",
		minutes: 6,
		marks: true,
	},
	{
		// The reported bug: this used to project "4 minutes" against a row the
		// printed clock booked for 7, so the deck's end time and every later row
		// ran three minutes apart. A minimum is not an allowance — the default is
		// the honest answer here, because the club never said how long this gets.
		name: "min only — a min is not a max, so the schedule uses the default",
		minMinutes: 4,
		maxMinutes: null,
		time: `${DEFAULT_SPEAKER_MINUTES} minutes`,
		minutes: DEFAULT_SPEAKER_MINUTES,
		marks: false,
	},
	{
		// The mirror case, and the reason the booked duration is NOT gated on
		// having a full range: 6 is a number the club typed. Overriding it with
		// the house default would reserve more of the meeting than they asked
		// for — the original bug in reverse. The range display and the marks do
		// drop, honestly, because there is no range.
		name: "max only — the typed maximum survives; only the range drops",
		minMinutes: null,
		maxMinutes: 6,
		time: "6 minutes",
		minutes: 6,
		marks: false,
	},
	{
		name: "neither end set",
		minMinutes: null,
		maxMinutes: null,
		time: `${DEFAULT_SPEAKER_MINUTES} minutes`,
		minutes: DEFAULT_SPEAKER_MINUTES,
		marks: false,
	},
	{
		// Unreachable through the edit surfaces now, but a legacy row could hold
		// it. An inverted pair is not a range, so no marks — but the max is still
		// a stated allowance, so it is still what gets booked.
		name: "min above max — no range, but the max is still the allowance",
		minMinutes: 9,
		maxMinutes: 4,
		time: "4 minutes",
		minutes: 4,
		marks: false,
	},
];

describe("speech-slot time agreement — deck ⇄ run sheet (#394)", () => {
	for (const c of WINDOW_CASES) {
		it(`${c.name}`, () => {
			// Two speakers, so the comparison is positional and a mismatch cannot
			// pass by both surfaces emitting one row.
			const slots = [
				...without("sp1"),
				{ ...speaker1, minMinutes: c.minMinutes, maxMinutes: c.maxMinutes },
			];
			for (const config of CONFIGS) {
				const beat = buildRunOfShow(config)[speechBeatIndex(config)];
				const rows = expandRunSheet(slots, [beat]);
				const slides = buildSlideDeck({
					meeting,
					club,
					slots,
					...config,
				}).filter(
					(s): s is Extract<Slide, { kind: "speech" }> => s.kind === "speech",
				);

				expect(rows).toHaveLength(2);
				expect(slides).toHaveLength(2);
				rows.forEach((row, i) => {
					const slide = slides[i];
					// THE invariant: the printed clock books exactly the upper bound
					// the projector is showing the speaker.
					expect(projectedUpperBound(slide.time)).toBe(row.minutes);
					// …and the Timer's marks exist exactly when the deck shows a real
					// range, so all three readings of the slot stay one reading.
					expect(row.marks !== null).toBe(slide.time.includes("–"));
				});

				// The case's own speaker (slotIndex 0 ⇒ first row/slide) states the
				// expected values outright, so this cannot pass by both surfaces
				// being wrong in the same direction.
				expect(slides[0].time).toBe(c.time);
				expect(rows[0].minutes).toBe(c.minutes);
				expect(rows[0].marks !== null).toBe(c.marks);
				// The untouched second speaker (5–7) proves the fixture is live.
				expect(slides[1].time).toBe("5–7 minutes");
				expect(rows[1].minutes).toBe(7);
			}
		});
	}
});
