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
import { assigneeDisplayName } from "./agenda";
import type {
	AgendaRow,
	AgendaSlot,
	BeatId,
	RunOfShowConfig,
} from "./agenda-runsheet";
import {
	buildRunOfShow,
	DEFAULT_SPEAKER_MINUTES,
	expandRunSheet,
	introducedSuffix,
	OPEN_LABEL,
} from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type HandoffTarget,
	type MeetingForDeck,
	type Slide,
} from "./agenda-slides";

/** A segment of the meeting that BOTH renderings are expected to show. */
type Section =
	| "toastmasterOpens"
	| "functionaryIntro"
	| "handoffSpeakers"
	| "speech"
	| "voteSpeaker"
	| "handoffTableTopics"
	| "tableTopics"
	| "voteTableTopics"
	| "handoffGeneralEvaluator"
	| "handoffEvaluators"
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
 * A hand-off's section is its TARGET, not merely its kind (#363).
 *
 * All five hand-off beats project the SAME slide kind, so a kind-keyed section
 * would give every hand-off one identity — and two of them are ADJACENT in the
 * template: the Table Topics Master handing to the General Evaluator, then the
 * General Evaluator handing to the speech evaluators. `dedupeConsecutive` would
 * collapse that pair into one entry on both surfaces, and the harness would
 * silently stop comparing one of them. That is the worst place to lose the
 * check: those two beats have DIFFERENT gates (a General Evaluator vs. any
 * evaluators) and different fallbacks, so they are exactly the pair most likely
 * to diverge. Keying on the target keeps them distinct.
 *
 * The two hand-offs INTO the General Evaluator — MCF's opening one and the one
 * out of Table Topics — do share an identity, deliberately: they are the same
 * transition, and every club that runs a segment between them (any club with
 * functionaries, speakers or Table Topics) separates them by most of the
 * meeting. A club running none of those collapses them on BOTH surfaces, since
 * both read the same gates, so nothing asymmetric can hide there. The
 * full-club sequence test below pins each of them by position anyway.
 *
 * Keyed by `HandoffTarget`, not `string`: a fifth target added to the deck is a
 * compile error here rather than a silent `unmapped-handoff:` row.
 */
const HANDOFF_SECTION: Record<HandoffTarget, Section> = {
	"the speakers": "handoffSpeakers",
	"the Table Topics Master": "handoffTableTopics",
	"the General Evaluator": "handoffGeneralEvaluator",
	"the speech evaluators": "handoffEvaluators",
};

/**
 * Section identity of each beat `buildRunOfShow` emits, IN ORDER (the spec's
 * table, plus the guest-comments beat #352 inserts and the hand-off beats #363
 * inserts). `detail` pins each entry to the actual beat, so a reworded or
 * reordered template fails here with a readable diff instead of silently
 * mislabelling a section — and `id`, where the beat carries one, pins the two
 * beats whose detail is identical ("Introduces the General Evaluator").
 */
const BEATS: { detail: string; section: Section | null; id?: BeatId }[] = [
	// Sergeant-at-Arms, Call to Order. A room-logistics event beat with no
	// counterpart in the deck: nothing is projected while phones go silent.
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
		detail:
			"Introduces the {roles}; each explains their role · the {role:grammarian} gives the Word of the Day",
		section: "functionaryIntro",
	},
	{
		detail: "Introduces the speakers",
		section: "handoffSpeakers",
	},
	{ detail: "Prepared speech", section: "speech" },
	{
		detail:
			"Calls for the {role:timer}'s report · opens voting for Best Speaker",
		section: "voteSpeaker",
	},
	{
		detail:
			"Introduces the {role:table_topics_master}{names:table_topics_master}",
		section: "handoffTableTopics",
	},
	{
		detail:
			"Impromptu topics using the Word of the Day · asks the {role:timer} to explain the timing",
		section: "tableTopics",
	},
	{
		detail:
			"Calls for the {role:timer}'s report · opens voting for Best Table Topics",
		section: "voteTableTopics",
	},
	{
		detail: "Introduces the {role:general_evaluator}{names:general_evaluator}",
		section: "handoffGeneralEvaluator",
		id: "geEvaluationHandoff",
	},
	{
		detail: "Introduces the speech evaluators",
		section: "handoffEvaluators",
	},
	// The evaluation-timing cue (#508). Excluded, by name, with the reason: it is
	// a STAGE DIRECTION — the General Evaluator asking the Timer to explain how an
	// evaluation is timed — and the deck has no counterpart because the room is
	// already shown the number, on each `evaluation` slide's "Time:" line. What
	// the deck lacks is the instruction to say it out loud, which is what a run
	// sheet is for and what a projected slide is not.
	//
	// So this is a genuine one-surface beat, not an oversight: adding a slide
	// would project a cue at the audience that is addressed to one officer.
	{
		detail: "Asks the {role:timer} to explain the timing for an evaluation",
		section: null,
	},
	{ detail: "Evaluates a speaker", section: "evaluation", id: "evaluation" },
	{
		detail:
			"Calls for the {role:timer}'s report · opens voting for Best Evaluator",
		section: "voteEvaluator",
	},
	{
		detail: "Evaluates the evaluators",
		section: "evaluatorEvaluation",
		id: "evaluatorEvaluation",
	},
	{
		// TEMPLATE detail — tokens unresolved (#584). `{roles}` resolves against
		// the beat's `requiresGroup: "reportingFunctionaries"` at expansion time.
		detail: "Calls for the {roles} to report",
		section: "functionaryReports",
	},
	{
		detail: "Overall meeting evaluation · returns control to the Toastmaster",
		section: "generalEvaluation",
		id: "generalEvaluation",
	},
	// The Toastmaster's awards handout. Compared as of #372: the beat is now
	// gated on the scored segments and names only those categories, which is
	// exactly how the deck's `awards` slide was already built, so the two are
	// comparable rather than a standing content difference.
	{
		detail: "Awards · {awards} · hands over to the President",
		section: "awards",
	},
	// President's club business. Event beat, no slide — the announcements SLIDE
	// exists but maps to `null` in SECTION_BY_SLIDE, so announcements are absent
	// from this comparison on both sides. That is why #442's ordering is pinned
	// by golden assertions in agenda-runsheet.test.ts and agenda-slides.test.ts
	// rather than here: this harness cannot see it.
	//
	// It no longer mentions guest comments: the beat below is the replacement
	// the clause was waiting for, and prompting for them twice is worse than
	// once.
	{ detail: "Club business · announcements", section: null },
	// Guest comments (#352), carved out of the President's closing so they get a
	// row to point at and minutes on the clock. Ungated, like the opening
	// remarks: every meeting can have guests, and the spec rules out a per-club
	// toggle. It is a SECTION, not an exclusion — #352 adds it to both surfaces,
	// so it has to be compared.
	//
	// Sits AFTER the announcements since #442: the club finishes its own
	// business, then hands the floor to visitors and closes on that.
	{
		detail: "Guest Comments · invites our guests to share their thoughts",
		section: "guestComments",
	},
	// The gavel, split out by #442 so guest comments can sit between the club's
	// business and the end of the meeting. Event beat, no slide.
	{ detail: "Adjourns", section: null },
];

/** The one beat only MCF's variant carries (#363): the Toastmaster introducing
 *  the General Evaluator before handing them the room for the functionary
 *  introductions. The standard flow has no early GE appearance. */
const GE_OPENING_INTRO_BEAT: (typeof BEATS)[number] = {
	detail: "Introduces the {role:general_evaluator}{names:general_evaluator}",
	section: "handoffGeneralEvaluator",
	id: "geOpeningHandoff",
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
	// The two TEMPLATED-meeting kinds (#agenda-templates). Excluded because this
	// whole file compares the STANDARD run of show against the STANDARD deck, and
	// neither of these can appear in either: `buildSlideDeck` never emits them and
	// `buildTemplateSlideDeck` never emits anything else from the compared set. A
	// templated meeting gets one builder or the other, never a mix.
	//
	// The parity they need is a different and stronger one, and it is structural
	// rather than asserted: `buildTemplateSlideDeck` takes the printed run sheet's
	// OWN `AgendaRow[]`, so the two surfaces cannot disagree about order or
	// content without the rows themselves being wrong. There is no second
	// derivation here to drift from the first — which is the defect this file
	// exists to catch on the standard path, designed out on the template path.
	// `agenda-template-slides.test.ts` pins that the rows are passed through
	// rather than re-walked.
	templateSection: null,
	templateBeat: null,
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
	// `handoff` is deliberately absent: one slide kind covers five beats, so its
	// section comes from the slide's TARGET via `HANDOFF_SECTION` (see the
	// comment there) rather than from this kind-keyed map. `Exclude` names the
	// carve-out, so adding any OTHER slide kind is still a compile error here.
} satisfies Record<Exclude<Slide["kind"], "handoff">, Section | null>;

/**
 * Deck slide kinds that project a DURATION, and the section — hence the beat —
 * whose budget that duration has to be (#356).
 *
 * Ordering parity alone let the two surfaces state different minutes for the
 * same beat, and they did: the speech-evaluation beat budgeted 3 minutes while
 * the deck's `EVALUATION_TIMING` said "2–3 minutes". Deriving the deck's
 * timings from the beat makes that unrepresentable, and makes this assertion
 * cheap — the check is just "the slide says what its beat budgets", with no
 * minute values restated here to drift in their turn.
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
	const deck = buildSlideDeck({
		meeting,
		club,
		slots,
		ballotUrl: BALLOT_URL,
		...config,
	});
	const out: string[] = [];
	for (const slide of deck) {
		if (slide.kind === "handoff") {
			out.push(HANDOFF_SECTION[slide.to]);
			continue;
		}
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
	logoUrl: null,
};

// This suite compares SECTION ORDER, never ballot content, so one fixture
// value stands in everywhere `buildSlideDeck` requires it (#510).
const BALLOT_URL = "https://gavelup.test/club/parity/meeting/2026-06-25/vote";

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

/** Every role that owns a hand-off or calls a vote, enabled but unclaimed —
 *  see the `CASES` entry below, and the test that pins it non-vacuously. */
const UNCLAIMED: AgendaSlot[] = [
	{ ...tmod, assigneeName: null },
	{ ...ttm, assigneeName: null },
	{ ...ge, assigneeName: null },
	speaker1,
	evaluator1,
	timer,
];

const CASES: { name: string; slots: AgendaSlot[] }[] = [
	{ name: "full nine-role club", slots: FULL },
	{
		name: "skeleton crew (Toastmaster, Speaker, Evaluator, Table Topics Master)",
		slots: [tmod, speaker1, evaluator1, ttm],
	},
	{ name: "no General Evaluator", slots: without("ge") },
	{
		// Both of the Best-Evaluator vote beat's `fallbacks` fire at once (#363):
		// no Timer drops the timer's-report clause, no General Evaluator moves the
		// row to the Toastmaster. Two independent triggers on one beat — the
		// combination a singular fallback could not express, so it is the one the
		// matrix has to carry.
		name: "no General Evaluator and no Timer",
		slots: without("ge", "ti"),
	},
	{
		// …and the case where the GE-coverage fallback has nowhere to land: the
		// Toastmaster is gone too, so the four beats with no `renderUnowned` drop
		// on both surfaces and the fifth prints unattributed on one and
		// uncredited on the other.
		name: "neither General Evaluator nor Toastmaster of the Day",
		slots: without("ge", "tm"),
	},
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
		// Since #363 this is the club that has somebody to give the evaluator
		// evaluation and nothing for them to evaluate, so BOTH surfaces drop that
		// section — reversing #367, which gated it on the General Evaluator alone
		// and kept the beat. It stays in the matrix precisely because it is where
		// print and deck would diverge if only one of them were re-gated.
		name: "General Evaluator but no evaluators",
		slots: without("ev1", "ev2"),
	},
	{ name: "no Toastmaster of the Day", slots: without("tm") },
	{ name: "no speakers", slots: without("sp1", "sp2") },
	{ name: "no Table Topics Master", slots: without("tt") },
	{
		// Both hand-off fallbacks fire at once (#363): with no Table Topics Master
		// the Toastmaster still holds the room, and with no General Evaluator the
		// Toastmaster is also who introduces the evaluators. One of the two rows
		// (the one INTO the General Evaluator) disappears entirely, since there is
		// nobody to introduce.
		name: "neither Table Topics Master nor General Evaluator",
		slots: without("tt", "ge"),
	},
	{
		// …and the case where a fallback has nowhere to fall back TO: the hand-off
		// into the General Evaluator is owned by the Table Topics Master, falls
		// back to the Toastmaster, and neither exists. The beat carries no
		// `renderUnowned`, so print drops the row and the deck must drop the slide.
		name: "no Toastmaster of the Day and no Table Topics Master",
		slots: without("tm", "tt"),
	},
	{
		// The two hand-offs into the General Evaluator become ADJACENT here —
		// nothing the club runs sits between them. Both surfaces collapse them the
		// same way (see `HANDOFF_SECTION`); this is the config that proves it.
		name: "Toastmaster and General Evaluator only",
		slots: [tmod, ge],
	},
	{
		name: "functionaries only (no leadership roles at all)",
		slots: [timer, grammarian],
	},
	{
		// The club the functionary intro's own GE cover decides (#363): that beat
		// is GE-owned under MCF's variant, so with functionaries, a Toastmaster and
		// no General Evaluator it is the Toastmaster who introduces them — and who
		// then calls for their reports. Both surfaces used to drop the intro here
		// and AGREE about it, which is why the section is also asserted PRESENT
		// below rather than left to this matrix.
		name: "Toastmaster and functionaries only, no General Evaluator",
		slots: [tmod, timer, grammarian],
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
		// keys) — a CONTENT divergence this ordering test cannot see, which is why
		// the run-sheet and deck suites assert the lists directly. What it can see
		// is the gate.
		name: "custom functionary-category role alongside the standard four",
		slots: [...FULL, jokeMaster],
	},
	{
		// The all-custom club: #368's disable lifecycle turns off all four standard
		// functionaries and the club runs its own. The functionary-intro and
		// functionary-reports beats used to vanish from print AND deck together —
		// consistent, and consistently wrong.
		name: "all-custom functionaries (standard four disabled)",
		slots: [tmod, ttm, ge, speaker1, evaluator1, jokeMaster],
	},
	{
		// The functionary-reports gate decision (#371): a Vote Counter is a
		// functionary, so they are INTRODUCED, but they give no report — so the
		// reports section is absent from both surfaces.
		name: "Vote Counter is the club's only functionary",
		slots: [tmod, ttm, ge, speaker1, evaluator1, voteCounter],
	},
	{
		// An admin can change a role's category (`applyRoleDefinitionUpdate`), so a
		// standard KEY under a non-functionary category is reachable. The category
		// is the definition (#371), so this club runs no functionaries and both
		// surfaces must drop the functionary-intro and functionary-reports beats
		// together — the case where a key-based gating fallback would have made
		// print render a beat the deck omits.
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
		// Enabled but UNCLAIMED (#363). Every other case in this matrix assigns
		// every slot, so the placeholder path is unexercised here — and it is the
		// one where the two surfaces resolve a hand-off's cast through genuinely
		// different code. The printed row builds "Role · — open —" from
		// `assigneeDisplay`; the slide's `from` and the vote slides' `caller` come
		// from `holder`, whose `??` fallbacks key on slot ABSENCE and so must NOT
		// fire for a slot that exists with nobody in it. `agenda-slides.test.ts`
		// asserts the deck half and says it matches "exactly as the printed row
		// does" — this is where that claim meets the printed row.
		name: "leadership roles enabled but unclaimed",
		slots: UNCLAIMED,
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
	{
		// GUEST assignees (#151/#450). `assigneeDisplayName` appends " · Guest",
		// so the printed `who` for these rows has three " · " segments instead of
		// two. Until #450 the harness could not hold this shape at all: `labelOf`
		// destructured only the first two, so it compared "Schinthia" against the
		// deck's "Schinthia · Guest" and reported a divergence that was not there.
		// Guests hold hand-off-owning roles here on purpose — a visiting
		// Toastmaster and a guest Table Topics Master are both ordinary, and they
		// are the roles whose names the comparison actually parses.
		name: "guest assignees on hand-off-owning roles",
		slots: [
			{ ...tmod, assigneeName: "Schinthia", assigneeIsGuest: true },
			{ ...ttm, assigneeName: "Rasheed", assigneeIsGuest: true },
			ge,
			speaker1,
			evaluator1,
			timer,
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
			// Details alone stopped being unique when #363 added a second
			// "Introduces the General Evaluator" beat, so the ids ride along: this is
			// what makes the two entries above provably the beats they claim to be
			// rather than each other.
			expect(template.map((b) => b.id)).toEqual(beats.map((b) => b.id));
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
		// both sides being wrong in the same way — including each hand-off's own
		// position, which is what keeps the two into the General Evaluator from
		// being interchangeable here.
		const expected: Section[] = [
			"toastmasterOpens",
			"functionaryIntro",
			"handoffSpeakers",
			"speech",
			"voteSpeaker",
			"handoffTableTopics",
			"tableTopics",
			"voteTableTopics",
			"handoffGeneralEvaluator",
			"handoffEvaluators",
			"evaluation",
			"voteEvaluator",
			"evaluatorEvaluation",
			"functionaryReports",
			"generalEvaluation",
			"awards",
			"guestComments",
		];
		for (const config of CONFIGS) {
			// MCF's variant adds the one hand-off its swap needs: the Toastmaster
			// introduces the General Evaluator before handing them the functionary
			// intro. Everything after is the standard sequence.
			const want: Section[] = config.geIntroducesFunctionaries
				? ["toastmasterOpens", "handoffGeneralEvaluator", ...expected.slice(1)]
				: expected;
			expect(printSections(FULL, config)).toEqual(want);
			expect(deckSections(FULL, config)).toEqual(want);
		}
	});

	it("drops the evaluator evaluation from BOTH surfaces when the club runs no evaluators (#363)", () => {
		// The matrix above only says the two surfaces agree — it would still pass
		// if both kept the section, which is what #367 had them do. This pins the
		// reversal: a club with a General Evaluator and nothing to evaluate has no
		// evaluator-evaluation section on either surface.
		const noEvaluators = without("ev1", "ev2");
		for (const config of CONFIGS) {
			expect(printSections(noEvaluators, config)).not.toContain(
				"evaluatorEvaluation",
			);
			expect(deckSections(noEvaluators, config)).not.toContain(
				"evaluatorEvaluation",
			);
			// The GE's other closing sections are NOT evaluator-gated and stay.
			expect(printSections(noEvaluators, config)).toContain(
				"functionaryReports",
			);
			expect(printSections(noEvaluators, config)).toContain(
				"generalEvaluation",
			);
			// Not vacuous: the same club WITH evaluators has the section.
			expect(printSections(FULL, config)).toContain("evaluatorEvaluation");
			expect(deckSections(FULL, config)).toContain("evaluatorEvaluation");
		}
	});

	it("keeps the functionary intro on BOTH surfaces when the Toastmaster covers for a missing General Evaluator (#363)", () => {
		// The defect a parity suite structurally cannot see: the matrix says the
		// two surfaces AGREE, and they agreed while both dropped this section under
		// MCF's variant — the functionary intro is GE-owned there, and it was the
		// one GE-owned beat without the shared cover. The club introduced nobody
		// and then called for their reports anyway. So the section is asserted
		// PRESENT, not merely mutual.
		const slots = [tmod, timer, grammarian];
		for (const config of CONFIGS) {
			expect(printSections(slots, config)).toContain("functionaryIntro");
			expect(deckSections(slots, config)).toContain("functionaryIntro");
			// The section it cues, which always had the cover — the mismatch between
			// the two is what made the gap visible.
			expect(printSections(slots, config)).toContain("functionaryReports");
			expect(deckSections(slots, config)).toContain("functionaryReports");
		}
	});
});

describe("run-sheet ⇄ deck duration parity (#356)", () => {
	/**
	 * The deck may state a beat's timing as a WINDOW ("2–3 minutes", #583) rather
	 * than a bare budget, so the parity rule is stated on the upper bound — the
	 * same shape the speech slides have used since #394, through the same helper.
	 *
	 * That is the invariant #356 actually bought: whatever the projector says,
	 * the LAST number in it is the minutes the printed clock reserves, so the two
	 * surfaces cannot drift. A slide that reintroduced an independently-authored
	 * range would fail here the moment its top left the beat.
	 */
	it("ends each timed slide on its own beat's budgeted duration", () => {
		for (const config of CONFIGS) {
			const template = buildRunOfShow(config);
			const deck = buildSlideDeck({
				meeting,
				club,
				slots: FULL,
				ballotUrl: BALLOT_URL,
				...config,
			});
			const checked: Section[] = [];
			for (const slide of deck) {
				if (!("time" in slide)) continue;
				const section = TIMED_SLIDES[slide.kind];
				if (section == null) continue;
				const beat =
					template[beatsFor(config).findIndex((b) => b.section === section)];
				expect(projectedUpperBound(slide.time)).toBe(beat.minutes);
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
// Hand-off + vote-caller content agreement (#363)
// ---------------------------------------------------------------------------

/**
 * Ordering parity says the two surfaces show the same sections in the same
 * order. It does NOT say they name the same PEOPLE, and the hand-off beats are
 * where that gap bites: their owner is resolved through a `fallback` on the
 * print side and through a `??` on the deck side, written separately. Two
 * expressions of one rule, which is the shape a divergence hides in — so this
 * compares the resolved owner itself, across the whole degenerate-club matrix.
 *
 * A hand-off row's `who` is always "Role · Name": the beats carry no
 * `renderUnowned`, so an unowned hand-off is dropped rather than printed as a
 * bare role, and the slide's `from` therefore has a counterpart for every row.
 */
const handoffRows = (
	slots: AgendaSlot[],
	config: RunOfShowConfig,
): AgendaRow[] =>
	expandRunSheet(slots, buildRunOfShow(config)).filter((r) => r.handoff);

const handoffSlides = (slots: AgendaSlot[], config: RunOfShowConfig) =>
	buildSlideDeck({
		meeting,
		club,
		slots,
		ballotUrl: BALLOT_URL,
		...config,
	}).filter(
		(s): s is Extract<Slide, { kind: "handoff" }> => s.kind === "handoff",
	);

/**
 * The role and holder out of a row's `who` ("Toastmaster of the Day · Dana" ⇒ "Dana").
 *
 * The two surfaces label the ROLE differently and always have: `expandRunSheet`
 * USED to print the BEAT's canonical `roleName` for every role row, while the
 * deck's `LegendEntry`s — the legend, the Word-of-the-Day presenter, and a
 * hand-off's `from` — carried the slot's own name, which is the club's if they
 * renamed it (#368). This helper existed to split that difference off so it could
 * not hide inside a mismatch here.
 *
 * #445 closed the gap: `expandRunSheet` reads the matched slot's `roleName` too,
 * so both surfaces name a role the same way and the hand-off comparison below
 * takes the WHOLE label. Splitting the string was the only thing hiding the
 * divergence, so keeping it split would have kept a rename mismatch invisible in
 * the one suite built to catch cross-surface drift.
 */
const labelOf = (who: string): { role: string; person: string | null } => {
	// Rejoin everything after the role. A guest assignee's display name is itself
	// `${name} · Guest` (#151, `assigneeDisplayName`), so the printed `who` has
	// THREE segments and a plain destructure kept only the first — reporting
	// "Schinthia" against the deck's "Schinthia · Guest" and inventing a
	// divergence that does not exist. `TimingLayout` already reconstructs the
	// same way with `rest.join(" · ")`; this matches it deliberately. #450
	const [role, ...rest] = who.split(" · ");
	return { role, person: rest.length > 0 ? rest.join(" · ") : null };
};

/** Just the person. Still the right comparison for the vote-caller suite below,
 *  which pins a deliberate difference in the ROLE half: a `renderUnowned` row
 *  fills its `who` column with the bare role name while the slide drops the
 *  attribution entirely, so comparing labels there would fail on purpose. */
const holderOf = (who: string): string | null => labelOf(who).person;

/**
 * GOLDEN OUTPUT — properties of what each surface EMITS, asserted directly
 * against every club shape (#450).
 *
 * Everything else in this file compares the two surfaces to each other, which
 * structurally cannot see a defect present in BOTH. That is not a hypothetical
 * limitation: the functionary-intro beat shipped without its General-Evaluator
 * cover fallback, so at an MCF-variant club with no GE the functionaries were
 * never introduced on EITHER surface while the Toastmaster still called for
 * their reports. The 24-shape matrix stayed green, and adding the club shape to
 * `CASES` ALSO passed — only a direct "this section must exist" assertion
 * caught it (d8a8f9a).
 *
 * So these assert truths about a single surface. They are the half of the suite
 * that can fail when both derivations are wrong together.
 */
/**
 * Shapes that currently DO emit a duplicate adjacent hand-off — a known open
 * defect (#449), not an accepted behaviour.
 *
 * Keyed `"<case name> — <flag>"`, each value is the exact duplicate emitted
 * today, so this is a characterization rather than a blanket exemption: the
 * assertion fails if the duplicate changes, if another shape grows one, AND
 * when #449 lands and it disappears. Fixing the bug is therefore forced to
 * shrink this table rather than being able to ignore it.
 *
 * Under MCF's variant a club with only a Toastmaster and a General Evaluator
 * runs nothing between the opening hand-off into the GE and the post-Table-
 * Topics one, and the latter falls back to the Toastmaster — so the same owner
 * hands to the same target twice in a row. The section-level comparison cannot
 * see it: `HANDOFF_SECTION` gives both the same identity and
 * `dedupeConsecutive` collapses them on BOTH surfaces, which is precisely the
 * "consistent wrongness" blind spot #450 exists to close.
 */
const KNOWN_DUPLICATE_HANDOFFS: Record<string, string[]> = {
	// EMPTY as of #449/#458 — `expandRunSheet` and `pushHandoff` now suppress a
	// hand-off identical to the one immediately before it, so no club shape emits
	// one. The table stays because the assertion reads it: a future shape that
	// grows a duplicate has to be listed here deliberately, in a diff, rather
	// than sliding in behind a green suite.
};

describe("golden output — properties of the run sheet itself (#450)", () => {
	/** Everyone the club actually rostered, as the sheet would render them. */
	const rostered = (slots: AgendaSlot[]): Set<string> =>
		new Set(
			slots
				.map((s) => assigneeDisplayName(s.assigneeName, s.assigneeIsGuest))
				.filter((n): n is string => n !== null),
		);

	for (const { name, slots } of CASES) {
		for (const config of CONFIGS) {
			const flag = config.geIntroducesFunctionaries
				? "MCF variant"
				: "standard";

			// A name on the sheet that nobody on the roster carries means the row
			// was built from the wrong slot, or a display string was mis-parsed.
			// Catches an invented holder on either surface, which no cross-surface
			// comparison can — both could invent the same one.
			it(`${name} — ${flag}: every printed holder is on the roster`, () => {
				const roster = rostered(slots);
				const printed = expandRunSheet(slots, buildRunOfShow(config))
					// A ROLE row is one carrying `roleKey` (#445); event beats have
					// none, and it may legitimately be null for a custom club role.
					.filter((r) => r.roleKey !== undefined)
					.map((r) => labelOf(r.who).person)
					.filter((p): p is string => p !== null && p !== OPEN_LABEL);

				// Not vacuous for any shape that has a claimed role.
				for (const person of printed) {
					expect(roster).toContain(person);
				}
			});

			// Two hand-offs in a row that resolve to the same owner AND target are
			// always wrong — the second is a duplicate, whoever emitted it. Both
			// surfaces collapse adjacent hand-offs (`HANDOFF_SECTION`), so a
			// comparison of the two agrees happily when both fail to collapse.
			it(`${name} — ${flag}: no two consecutive hand-offs repeat owner and target`, () => {
				const pairs = handoffRows(slots, config).map(
					(r) => `${r.who} → ${r.detail}`,
				);
				const repeats = pairs.filter((p, i) => i > 0 && pairs[i - 1] === p);
				expect(repeats).toEqual(
					KNOWN_DUPLICATE_HANDOFFS[`${name} — ${flag}`] ?? [],
				);
			});

			// The exact defect that shipped. A club running functionaries must be
			// told to introduce them, on both surfaces, under BOTH configs — the
			// beat is GE-owned under the MCF variant, which is where it broke.
			it(`${name} — ${flag}: a club with functionaries introduces them`, () => {
				const hasFunctionaries = slots.some(
					(s) => s.category === "functionary",
				);
				const has = (key: string) => slots.some((s) => s.roleKey === key);
				// Ownership is config-dependent, and the fallback only runs one way.
				// Standard: the beat is Toastmaster-owned outright, so no Toastmaster
				// means nobody to deliver it and no row is CORRECT. MCF variant: it is
				// GE-owned with `GE_COVERED_BY_TOASTMASTER`, so either role suffices.
				const hasOwner = config.geIntroducesFunctionaries
					? has("general_evaluator") || has("toastmaster_of_the_day")
					: has("toastmaster_of_the_day");
				if (!hasFunctionaries || !hasOwner) return;

				expect(printSections(slots, config)).toContain("functionaryIntro");
				expect(deckSections(slots, config)).toContain("functionaryIntro");
			});
		}
	}

	// Guards the guard: if the fixtures stopped containing functionaries, the
	// section assertion above would early-return everywhere and prove nothing.
	it("the matrix actually exercises the functionary-intro assertion", () => {
		const exercised = CASES.filter(
			({ slots }) =>
				slots.some((s) => s.category === "functionary") &&
				slots.some(
					(s) =>
						s.roleKey === "toastmaster_of_the_day" ||
						s.roleKey === "general_evaluator",
				),
		);
		expect(exercised.length).toBeGreaterThan(2);
	});
});

describe("hand-off agreement — deck ⇄ run sheet (#363)", () => {
	for (const { name, slots } of CASES) {
		for (const config of CONFIGS) {
			const flag = config.geIntroducesFunctionaries
				? "MCF variant"
				: "standard";
			it(`${name} — ${flag}`, () => {
				// `Introduces ${to}` IS the beat's detail, so this compares the copy as
				// well as the cast: same ROLE LABEL, same person, same target, same
				// order. The role label is in scope since #445 — see `labelOf`.
				expect(
					handoffSlides(slots, config).map((s) => ({
						role: s.from.role,
						person: s.from.name,
						// `toLabel`, not `to` (#462): the printed detail resolves the
						// club's own name for the target, so comparing against the
						// canonical identity would fail for a renamed role — which is
						// exactly the divergence #462 removes.
						//
						// …plus the people (#585). Built here from the SLIDE's own
						// `toNames` through the shared formatter, so this still compares
						// two independently-selected lists rather than asserting a value
						// against itself: the printed side reaches its names through
						// `{names:…}` and `expandRunSheet`, the deck side through
						// `pushHandoff`. Only the rendering is shared.
						detail: `Introduces ${s.toLabel}${introducedSuffix(s.toNames)}`,
					})),
				).toEqual(
					handoffRows(slots, config).map((r) => ({
						...labelOf(r.who),
						detail: r.detail,
					})),
				);
			});
		}
	}

	// #462: the TARGET of a hand-off, not just its owner. #445 fixed the `who`
	// column, leaving the printed detail two rows above still saying OUR name for
	// a role the club had renamed — the page contradicting itself.
	//
	// Asserted on BOTH surfaces from one fixture, because the deck was the reason
	// this was deferred: its `to` is an identity key (it names the jump-grid cell
	// and gives the parity comparison its section), so the rename had to land on
	// a separate rendered label rather than on the key.
	it("names the hand-off TARGET as the club does, on both surfaces (#462)", () => {
		const renamed = [
			{ ...tmod, roleName: "Master of Ceremonies" },
			{ ...ge, roleName: "Chief Evaluator" },
			{ ...ttm, roleName: "Topics Chief" },
			speaker1,
			evaluator1,
			timer,
		];
		const config = { geIntroducesFunctionaries: false };

		const details = handoffRows(renamed, config).map((r) => r.detail);
		// Whole detail, names included (#585) — a `startsWith` here would stop
		// noticing if the suffix started naming the wrong person.
		expect(details).toContain("Introduces the Chief Evaluator: Saiful");
		expect(details).toContain("Introduces the Topics Chief: Rasheed");
		// The canonical names are gone from the printed page entirely. Substring
		// checks, because the row no longer ENDS at the role name.
		expect(details.some((d) => d.includes("the General Evaluator"))).toBe(
			false,
		);
		expect(details.some((d) => d.includes("the Table Topics Master"))).toBe(
			false,
		);

		const slides = handoffSlides(renamed, config);
		expect(slides.map((s) => s.toLabel)).toEqual(
			expect.arrayContaining(["the Chief Evaluator", "the Topics Chief"]),
		);
		// ...while the IDENTITY stays canonical, so the jump grid and the parity
		// sections keep working. This is the split the fix turns on: if `to` ever
		// followed the rename, `HANDOFF_HEADER` would miss and the grid would fall
		// back to a bare "Hand-off".
		expect(slides.map((s) => s.to)).toEqual(
			expect.arrayContaining([
				"the General Evaluator",
				"the Table Topics Master",
			]),
		);
	});

	// The two GROUP targets stay English on purpose: they name a set, not a role,
	// and pluralising an arbitrary club-chosen name ("Speech Giver" → ?) is worse
	// than leaving prose that is already correct for every club.
	it("leaves the group targets as prose even when the roles are renamed (#462)", () => {
		const renamed = [
			{ ...tmod, roleName: "Master of Ceremonies" },
			{ ...ge, roleName: "Chief Evaluator" },
			{ ...speaker1, roleName: "Presenter" },
			{ ...evaluator1, roleName: "Reviewer" },
		];
		const details = handoffRows(renamed, {
			geIntroducesFunctionaries: false,
		}).map((r) => r.detail);
		// The GROUP prose is unchanged by the rename; only the people appended
		// after it vary (#585), and they are the club's members either way.
		expect(details).toContain("Introduces the speakers");
		expect(details).toContain("Introduces the speech evaluators");
		// The renamed role names must not leak into the group prose itself.
		expect(details.some((d) => d.includes("Presenter"))).toBe(false);
		expect(details.some((d) => d.includes("Reviewer"))).toBe(false);
	});

	it("the full club's hand-offs name the people the printed rows name", () => {
		// Not vacuous: the matrix above would pass if BOTH surfaces emitted nothing.
		expect(
			handoffSlides(FULL, { geIntroducesFunctionaries: true }).map(
				(s) => `${s.from.role} · ${s.from.name} → ${s.to}`,
			),
		).toEqual([
			"Toastmaster of the Day · Schinthia → the General Evaluator",
			"Toastmaster of the Day · Schinthia → the speakers",
			"Toastmaster of the Day · Schinthia → the Table Topics Master",
			"Table Topics Master · Rasheed → the General Evaluator",
			"General Evaluator · Saiful → the speech evaluators",
		]);
	});

	it("keeps the cue for a role that is enabled but unclaimed", () => {
		// The `UNCLAIMED` matrix entry proves the two surfaces AGREE; it would still
		// agree if both had dropped the hand-offs, which is a single conceptual
		// change ("an unassigned role is a role the club doesn't run") applied to
		// both. An enabled-but-unclaimed role IS one the club runs — whoever fills
		// it on the day needs the cue as much as anyone — so this pins the copy each
		// surface keeps, placeholder and all.
		const config: RunOfShowConfig = { geIntroducesFunctionaries: false };
		expect(
			handoffSlides(UNCLAIMED, config).map(
				(s) => `${s.from.role} · ${s.from.name} → ${s.to}`,
			),
		).toEqual([
			`Toastmaster of the Day · ${OPEN_LABEL} → the speakers`,
			`Toastmaster of the Day · ${OPEN_LABEL} → the Table Topics Master`,
			`Table Topics Master · ${OPEN_LABEL} → the General Evaluator`,
			`General Evaluator · ${OPEN_LABEL} → the speech evaluators`,
		]);
		expect(handoffRows(UNCLAIMED, config).map((r) => r.who)).toEqual([
			`Toastmaster of the Day · ${OPEN_LABEL}`,
			`Toastmaster of the Day · ${OPEN_LABEL}`,
			`Table Topics Master · ${OPEN_LABEL}`,
			`General Evaluator · ${OPEN_LABEL}`,
		]);
	});

	it("labels the role as the CLUB names it, on BOTH surfaces (#445)", () => {
		// The #368 gap this used to pin is closed. It read: "whoever closes the gap
		// should be moving the PRINTED row onto the club's name, and this test is
		// what will tell them the surfaces have converged." They have converged —
		// `expandRunSheet` reads the matched slot's `roleName` now instead of the
		// beat's constant, which is the rule the deck already followed everywhere it
		// builds a `LegendEntry`. Kept pointing at the same club shape so the
		// convergence is asserted where the divergence was recorded.
		const slots = [
			{ ...tmod, roleName: "Master of Ceremonies" },
			speaker1,
			ge,
			evaluator1,
		];
		const config: RunOfShowConfig = { geIntroducesFunctionaries: false };
		expect(handoffSlides(slots, config)[0].from).toEqual({
			role: "Master of Ceremonies",
			name: "Schinthia",
		});
		expect(handoffRows(slots, config)[0].who).toBe(
			"Master of Ceremonies · Schinthia",
		);
	});
});

/**
 * The three vote slides, named rather than matched on a `"vote"` prefix: a
 * future kind whose name starts with "vote" but carries no caller would slip
 * through a prefix filter and read `undefined`, which `toEqual` against a
 * printed row would then report as a divergence in the wrong place — or hide
 * one. Naming them keeps the type system in the loop.
 */
const VOTE_KINDS = ["voteSpeaker", "voteTableTopics", "voteEvaluator"] as const;
const isVoteSlide = (
	s: Slide,
): s is Extract<Slide, { kind: (typeof VOTE_KINDS)[number] }> =>
	(VOTE_KINDS as readonly string[]).includes(s.kind);

describe("vote-caller agreement — deck ⇄ run sheet (#363)", () => {
	/** The three vote beats' rows, in order. */
	const voteRows = (slots: AgendaSlot[], config: RunOfShowConfig) =>
		expandRunSheet(slots, buildRunOfShow(config)).filter((r) =>
			r.detail.includes("voting for Best"),
		);

	for (const { name, slots } of CASES) {
		for (const config of CONFIGS) {
			const flag = config.geIntroducesFunctionaries
				? "MCF variant"
				: "standard";
			it(`${name} — ${flag}`, () => {
				const callers = buildSlideDeck({
					meeting,
					club,
					slots,
					ballotUrl: BALLOT_URL,
					...config,
				})
					.filter(isVoteSlide)
					.map((s) => s.caller?.name ?? null);
				// `renderUnowned` keeps the printed row and fills its `who` column with
				// the bare role name; the slide has no column to fill and drops the
				// attribution instead. So a row with no holder is a slide with no
				// caller — the one place the two surfaces deliberately say different
				// things, and this is where that is pinned rather than assumed.
				expect(callers).toEqual(
					voteRows(slots, config).map((r) => holderOf(r.who)),
				);
			});
		}
	}
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
	/** Whether the Timer gets green·yellow·red marks. */
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
					ballotUrl: BALLOT_URL,
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
