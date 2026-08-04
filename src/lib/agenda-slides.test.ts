import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import { beatDuration, buildRunOfShow } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
	type Slide,
	type SlideDeckInput,
} from "./agenda-slides";
import { slideLayout } from "./slide-layout";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
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

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-06-25T23:45:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
};

const club: ClubForDeck = {
	name: "MCF Toastmasters Club",
	clubNumber: "28677176",
	district: "District 39",
	timezone: "America/Chicago",
	meetingSchedule: "2nd & 4th Thursday",
	logoUrl: null,
};

/** `buildSlideDeck` with the standard fixtures, overridden per test. The club
 *  config is required (#367), so the helper pins the standard flow and each
 *  test opts into MCF's variant explicitly. */
const build = (over: Partial<SlideDeckInput> = {}) =>
	buildSlideDeck({
		meeting,
		club,
		slots: [],
		geIntroducesFunctionaries: false,
		...over,
	});

const kinds = (slots: AgendaSlot[] = []) => build({ slots }).map((s) => s.kind);

describe("buildSlideDeck anchors", () => {
	it("always emits title and thankYou — even with no slots", () => {
		// The Toastmaster slide is NOT an anchor: it is the Toastmaster's opening
		// beat in slide form and is gated on the role, like every other section
		// (#367).
		expect(kinds([])).toEqual(["title", "guestComments", "thankYou"]);
	});

	it("title slide carries club identity + schedule time", () => {
		const [title] = build();
		expect(title).toMatchObject({
			kind: "title",
			clubName: "MCF Toastmasters Club",
			clubNumber: "28677176",
			district: "District 39",
			timezone: "America/Chicago",
		});
	});

	it("toastmaster slide shows the assignee, or the open placeholder when unclaimed", () => {
		const withTmod = build({
			slots: [
				slot({
					roleName: "Toastmaster of the Day",
					assigneeName: "Schinthia",
				}),
			],
		});
		expect(withTmod[1]).toMatchObject({
			kind: "toastmaster",
			name: "Schinthia",
		});
		// Enabled but unclaimed: the role still has a slot, so it still projects —
		// as a sign-up prompt, exactly as the run sheet prints it.
		const unclaimed = build({
			slots: [slot({ roleName: "Toastmaster of the Day", assigneeName: null })],
		});
		expect(unclaimed[1]).toMatchObject({
			kind: "toastmaster",
			name: "— open —",
		});
	});

	it("omits the toastmaster slide when the club does not run the role (#367)", () => {
		// No Toastmaster-of-the-Day slot at all (the role is disabled, #368) ⇒ the
		// run sheet omits that beat, so the deck must omit the slide rather than
		// projecting "— open —" for a role the club never configured.
		expect(kinds([slot({ roleName: "Grammarian" })])).not.toContain(
			"toastmaster",
		);
	});

	it("thankYou carries the club meeting schedule", () => {
		expect(build().at(-1)).toMatchObject({
			kind: "thankYou",
			meetingSchedule: "2nd & 4th Thursday",
		});
	});
});

describe("buildSlideDeck toastmaster intro + word of the day", () => {
	it("merges theme + WOD word into one toastmasterIntro slide", () => {
		const deck = build({
			meeting: { ...meeting, theme: "Unity", wordOfTheDay: "Synergy" },
		});
		const intro = deck.find((s) => s.kind === "toastmasterIntro");
		expect(intro).toMatchObject({ theme: "Unity", word: "Synergy" });
	});

	it("emits a standalone wordOfDay slide only when a definition/example exists", () => {
		const withDef = build({
			meeting: {
				...meeting,
				wordOfTheDay: "Synergy",
				wodDefinition: "cooperation",
			},
		});
		expect(withDef.some((s) => s.kind === "wordOfDay")).toBe(true);

		const wordOnly = build({
			meeting: { ...meeting, wordOfTheDay: "Synergy" },
		});
		expect(wordOnly.some((s) => s.kind === "wordOfDay")).toBe(false);
		expect(wordOnly.some((s) => s.kind === "toastmasterIntro")).toBe(true);
	});

	it("omits toastmasterIntro when neither theme nor WOD is set", () => {
		expect(build().some((s) => s.kind === "toastmasterIntro")).toBe(false);
	});

	it("sits with the Toastmaster's opening, BEFORE the functionary intro (#354)", () => {
		// The word, its definition and its example land together up front, where
		// the room can use them — not stranded several beats later, after the
		// functionaries have been introduced.
		expect(
			build({
				meeting: {
					...meeting,
					theme: "Unity",
					wordOfTheDay: "Synergy",
					wodDefinition: "cooperation",
				},
				slots: [tmod, grammarian],
			}).map((s) => s.kind),
		).toEqual([
			"title",
			"toastmaster",
			"toastmasterIntro",
			"wordOfDay",
			"functionaryIntro",
			// No General Evaluator at this club, so the Toastmaster covers the GE's
			// closing slides (#363). They sit AFTER the functionary intro, which is
			// what this test is about. No `evaluatorEvaluation`: the club runs no
			// evaluators, and that slide is gated on them.
			"functionaryReports",
			"generalEvaluation",
			"guestComments",
			"thankYou",
		]);
	});
});

/**
 * The Grammarian presents the Word of the Day (#354). The slide sits inside the
 * Toastmaster's opening, so it has to say whose it is — otherwise its position
 * implies the Toastmaster (or, under MCF's variant, the General Evaluator)
 * delivers it.
 */
describe("buildSlideDeck word of the day presenter (#354)", () => {
	const wodMeeting: MeetingForDeck = {
		...meeting,
		wordOfTheDay: "Synergy",
		wodDefinition: "cooperation",
	};
	const wod = (slots: AgendaSlot[]) =>
		build({ meeting: wodMeeting, slots }).find((s) => s.kind === "wordOfDay");

	it("attributes the Grammarian and who holds the role", () => {
		expect(wod([tmod, grammarian])).toMatchObject({
			presenter: { role: "Grammarian", name: "Mona" },
		});
	});

	it("shows the open placeholder when the Grammarian is unclaimed", () => {
		expect(
			wod([
				tmod,
				slot({ id: "gr", roleName: "Grammarian", assigneeName: null }),
			]),
		).toMatchObject({ presenter: { role: "Grammarian", name: "— open —" } });
	});

	it("uses the club's OWN name for a renamed Grammarian (#368)", () => {
		expect(
			wod([
				tmod,
				slot({
					id: "gr",
					roleKey: "grammarian",
					roleName: "Wordsmith",
					assigneeName: "Mona",
				}),
			]),
		).toMatchObject({ presenter: { role: "Wordsmith", name: "Mona" } });
	});

	it("attributes nobody when the club does not run a Grammarian", () => {
		// Better a bare word than crediting a role this club never configured.
		expect(wod([tmod, timer])).toMatchObject({ presenter: null });
	});
});

describe("buildSlideDeck speeches", () => {
	const speakers = [
		slot({
			id: "sp1",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 0,
			assigneeName: "Rehanna Khan",
			speechTitle: "A Tasteful Historic Profile",
			projectLevel: "Level 1",
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot({
			id: "sp2",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 1,
			assigneeName: "Sudheer Isanaka",
			minMinutes: 5,
			maxMinutes: 7,
		}),
	];

	it("emits one speech slide per speaker then a vote slide", () => {
		expect(kinds(speakers)).toEqual([
			"title",
			"speech",
			"speech",
			"voteSpeaker",
			"awards",
			"guestComments",
			"thankYou",
		]);
	});

	it("binds speakers by role key, not the isSpeakerRole flag (#367/#368)", () => {
		// A club-invented role can also carry isSpeakerRole. It binds to no beat,
		// so it must project no speech slide and win no Best-Speaker vote either.
		const custom = slot({
			id: "cus",
			roleName: "Ice Breaker",
			roleKey: null,
			category: "speaker",
			isSpeakerRole: true,
			assigneeName: "Nadia",
		});
		expect(kinds([custom])).toEqual(["title", "guestComments", "thankYou"]);
		// …while a RENAMED standard speaker role keeps its key and still binds.
		const renamed = slot({
			id: "sp",
			roleName: "Featured Speaker",
			roleKey: "speaker",
			category: "speaker",
			isSpeakerRole: true,
			assigneeName: "Rehanna Khan",
		});
		expect(kinds([renamed])).toContain("speech");
	});

	it("speech slide carries speaker, title, level, and real time range", () => {
		const speech = build({ slots: speakers }).find((s) => s.kind === "speech");
		expect(speech).toMatchObject({
			label: "First Speech",
			speaker: "Rehanna Khan",
			title: "A Tasteful Historic Profile",
			projectLevel: "Level 1",
			time: "5–7 minutes",
		});
	});

	it("vote slide lists assigned speaker names, skipping open slots", () => {
		const withOpen = [
			...speakers,
			slot({
				id: "sp3",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 2,
				assigneeName: null,
			}),
		];
		const vote = build({ slots: withOpen }).find(
			(s) => s.kind === "voteSpeaker",
		);
		expect(vote).toMatchObject({ names: ["Rehanna Khan", "Sudheer Isanaka"] });
	});

	it("labels multiple speeches with ordinal words; a lone speech is 'Speech'", () => {
		const two = build({ slots: speakers }).filter((s) => s.kind === "speech");
		expect(two.map((s) => (s as { label: string }).label)).toEqual([
			"First Speech",
			"Second Speech",
		]);
		const one = build({ slots: [speakers[0]] }).find(
			(s) => s.kind === "speech",
		);
		expect(one).toMatchObject({ label: "Speech" });
	});
});

describe("buildSlideDeck table topics", () => {
	const tt = slot({
		id: "tt",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "Rasheed Bustamam",
	});

	it("emits tableTopics + voteTableTopics when the role exists", () => {
		expect(kinds([tt])).toEqual([
			"title",
			"tableTopics",
			"voteTableTopics",
			"awards",
			"guestComments",
			"thankYou",
		]);
	});

	it("table topics slide has master + hardcoded standard timing", () => {
		const slide = build({ slots: [tt] }).find((s) => s.kind === "tableTopics");
		expect(slide).toMatchObject({
			master: "Rasheed Bustamam",
			timing: "1–2 minutes per speaker",
		});
	});

	it("omits both table-topics slides when the role is absent", () => {
		expect(kinds([])).not.toContain("tableTopics");
		expect(kinds([])).not.toContain("voteTableTopics");
	});

	// #355: the beat is literally "Impromptu topics using the Word of the Day", so
	// the word has to be on the slide the room is looking at while they use it.
	// The standalone `wordOfDay` slide (#354) is a dozen slides back by then.
	describe("carries the Word of the Day (#355)", () => {
		const wodOf = (over: Partial<MeetingForDeck>) =>
			build({ slots: [tt], meeting: { ...meeting, ...over } }).find(
				(s) => s.kind === "tableTopics",
			);

		it("reminds the room of the word and its definition", () => {
			expect(
				wodOf({
					wordOfTheDay: "Momentum",
					wodDefinition: "impetus gained by a moving object",
				}),
			).toMatchObject({
				word: "Momentum",
				definition: "impetus gained by a moving object",
			});
		});

		it("shows the word even with no definition — a narrower gate than #354's", () => {
			// The standalone slide needs a definition or an example to be worth a
			// slide of its own, so a club that sets only the word gets none at all —
			// which is exactly the club whose Table Topics segment would otherwise
			// have no record of the word anywhere.
			expect(wodOf({ wordOfTheDay: "Momentum" })).toMatchObject({
				word: "Momentum",
				definition: null,
			});
		});

		it("carries no example — the word is being used here, not presented", () => {
			expect(
				wodOf({
					wordOfTheDay: "Momentum",
					wodDefinition: "impetus",
					wodExample: "The momentum of the river keeps moving forward.",
				}),
			).not.toMatchObject({ example: expect.anything() });
		});

		it("is blank when the meeting has no Word of the Day", () => {
			expect(wodOf({})).toMatchObject({ word: null, definition: null });
		});

		it("ignores a whitespace-only word, like every other WOD surface", () => {
			expect(wodOf({ wordOfTheDay: "   ", wodDefinition: "  " })).toMatchObject(
				{
					word: null,
					definition: null,
				},
			);
		});
	});
});

describe("buildSlideDeck vote slides (#367)", () => {
	const timer = slot({ id: "ti", roleName: "Timer", assigneeName: "Alex" });
	const speaker = slot({
		id: "sp1",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "Rehanna Khan",
	});
	const ttm = slot({
		id: "tt",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "Rasheed Bustamam",
	});
	const evaluator = slot({
		id: "ev",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Saiful Haque",
	});

	// Every vote beat in the run sheet (6, 8 and 10) drops its timer's-report
	// clause via the same `fallback` when the club runs no Timer. All three vote
	// SLIDES have to adapt on the same signal or the deck prompts the presenter
	// to call for a report from a role nobody holds.
	it("all three vote slides carry whether the club runs a Timer", () => {
		const votes = (slots: AgendaSlot[]) => {
			const deck = build({ slots });
			return {
				speaker: deck.find((s) => s.kind === "voteSpeaker"),
				tableTopics: deck.find((s) => s.kind === "voteTableTopics"),
				evaluator: deck.find((s) => s.kind === "voteEvaluator"),
			};
		};
		const withTimer = votes([speaker, ttm, evaluator, timer]);
		expect(withTimer.speaker).toMatchObject({ hasTimer: true });
		expect(withTimer.tableTopics).toMatchObject({ hasTimer: true });
		expect(withTimer.evaluator).toMatchObject({ hasTimer: true });

		const noTimer = votes([speaker, ttm, evaluator]);
		expect(noTimer.speaker).toMatchObject({ hasTimer: false });
		expect(noTimer.tableTopics).toMatchObject({ hasTimer: false });
		expect(noTimer.evaluator).toMatchObject({ hasTimer: false });
	});
});

/**
 * The deck's half of #363. The printed run sheet already says who hands the room
 * to whom; these slides put the same cue on the wall at the moment the person on
 * deck needs it, and name the segment leader who calls each vote.
 *
 * Every gate and every fallback here mirrors the run sheet's hand-off beats —
 * `agenda-parity.test.ts` proves the two agree row-for-slide across the whole
 * degenerate-club matrix; this suite pins the copy.
 */
describe("hand-off slides (#363)", () => {
	const totd = slot({
		id: "tm",
		roleName: "Toastmaster of the Day",
		category: "leadership",
		assigneeName: "Faisal",
	});
	const ttMaster = slot({
		id: "tt",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "Rasheed",
	});
	const genEval = slot({
		id: "ge",
		roleName: "General Evaluator",
		category: "leadership",
		assigneeName: "Riyaz",
	});
	const speaker = slot({
		id: "sp1",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "Jagpal",
	});
	const evaluator = slot({
		id: "ev1",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Priya",
		evaluatesSlotId: "sp1",
		evaluates: { speakerName: "Jagpal" },
	});
	const CLUB = [totd, ttMaster, genEval, speaker, evaluator];

	const handoffs = (over: Partial<SlideDeckInput> = {}) =>
		build({ slots: CLUB, ...over }).filter(
			(s): s is Extract<Slide, { kind: "handoff" }> => s.kind === "handoff",
		);

	/** The three vote slides, named rather than matched on a `"vote"` prefix — a
	 *  future kind starting with "vote" but carrying no caller would otherwise
	 *  slip through and read `undefined` instead of failing to compile. */
	const VOTE_KINDS = [
		"voteSpeaker",
		"voteTableTopics",
		"voteEvaluator",
	] as const;
	const isVoteSlide = (
		s: Slide,
	): s is Extract<Slide, { kind: (typeof VOTE_KINDS)[number] }> =>
		(VOTE_KINDS as readonly string[]).includes(s.kind);

	// `CLUB` runs no functionary, so the OPENING hand-off into the General
	// Evaluator no longer fires (#449): it exists only to set up the functionary
	// intro, which this club has nothing to fill. The post-Table-Topics hand-off
	// into the GE is unaffected and still appears below, from the Table Topics
	// Master. The next test covers the club that does run functionaries.
	it("projects each hand-off, in run-sheet order, naming both parties", () => {
		expect(handoffs({ geIntroducesFunctionaries: true })).toEqual([
			{
				kind: "handoff",
				from: { role: "Toastmaster of the Day", name: "Faisal" },
				to: "the speakers",
				toLabel: "the speakers",
			},
			{
				kind: "handoff",
				from: { role: "Toastmaster of the Day", name: "Faisal" },
				to: "the Table Topics Master",
				toLabel: "the Table Topics Master",
			},
			{
				kind: "handoff",
				from: { role: "Table Topics Master", name: "Rasheed" },
				to: "the General Evaluator",
				toLabel: "the General Evaluator",
			},
			{
				kind: "handoff",
				from: { role: "General Evaluator", name: "Riyaz" },
				to: "the speech evaluators",
				toLabel: "the speech evaluators",
			},
		]);
	});

	// The other half of the narrowing above: with functionaries present the
	// opening hand-off is back, so #449 gated the beat rather than removing it.
	it("MCF variant: the opening GE hand-off returns once the club runs functionaries", () => {
		const timer = {
			...totd,
			id: "ti",
			roleKey: "timer",
			roleName: "Timer",
			category: "functionary" as const,
			assigneeName: "Tara",
		};
		expect(
			handoffs({
				geIntroducesFunctionaries: true,
				slots: [...CLUB, timer],
			}).map((s) => s.to),
		).toEqual([
			"the General Evaluator",
			"the speakers",
			"the Table Topics Master",
			"the General Evaluator",
			"the speech evaluators",
		]);
	});

	it("has no opening GE hand-off in the standard flow — the GE is not introduced there", () => {
		// The beat exists only under MCF's variant, where the swap puts the General
		// Evaluator in front of the room at the top of the meeting.
		expect(handoffs().map((s) => s.to)).toEqual([
			"the speakers",
			"the Table Topics Master",
			"the General Evaluator",
			"the speech evaluators",
		]);
	});

	it("names the caller on each vote slide", () => {
		const deck = build({ slots: CLUB, geIntroducesFunctionaries: true });
		const votes = deck.filter(isVoteSlide);
		expect(votes.map((s) => s.caller)).toEqual([
			{ role: "Toastmaster of the Day", name: "Faisal" },
			{ role: "Table Topics Master", name: "Rasheed" },
			{ role: "General Evaluator", name: "Riyaz" },
		]);
	});

	it("leaves the caller null when the club runs no such role — the vote still happens", () => {
		// The run sheet keeps the row via `renderUnowned` and prints the bare role
		// name in its `who` column; the slide has no column to fill, so it drops the
		// attribution line rather than crediting a role nobody holds.
		const deck = build({ slots: [speaker, evaluator] });
		expect(deck.find((s) => s.kind === "voteSpeaker")).toMatchObject({
			caller: null,
		});
	});

	it("hands the room back to the Toastmaster when the club runs no Table Topics Master", () => {
		// Mirrors the beat's `fallback: { unless: TABLE_TOPICS_ROLE, owner:
		// TOASTMASTER_ROLE }` — with no Table Topics segment the Toastmaster never
		// gave the room away, so the hand-off stays on them rather than vanishing.
		expect(handoffs({ slots: [totd, genEval, speaker, evaluator] })).toEqual([
			{
				kind: "handoff",
				from: { role: "Toastmaster of the Day", name: "Faisal" },
				to: "the speakers",
				toLabel: "the speakers",
			},
			{
				kind: "handoff",
				from: { role: "Toastmaster of the Day", name: "Faisal" },
				to: "the General Evaluator",
				toLabel: "the General Evaluator",
			},
			{
				kind: "handoff",
				from: { role: "General Evaluator", name: "Riyaz" },
				to: "the speech evaluators",
				toLabel: "the speech evaluators",
			},
		]);
	});

	it("hands the evaluators to the Toastmaster when the club runs no General Evaluator", () => {
		const tos = handoffs({ slots: [totd, ttMaster, speaker, evaluator] });
		// No General Evaluator ⇒ nobody to introduce, so that hand-off is gone…
		expect(tos.map((s) => s.to)).toEqual([
			"the speakers",
			"the Table Topics Master",
			"the speech evaluators",
		]);
		// …and the Toastmaster introduces the evaluators instead.
		expect(tos.at(-1)?.from).toEqual({
			role: "Toastmaster of the Day",
			name: "Faisal",
		});
	});

	it("drops the hand-off when neither the owner nor the fallback owner exists", () => {
		// No Table Topics Master AND no Toastmaster of the Day: the beat has nobody
		// to own it and carries no `renderUnowned`, so print omits the row and the
		// deck must omit the slide.
		expect(handoffs({ slots: [genEval, speaker, evaluator] })).toEqual([
			{
				kind: "handoff",
				from: { role: "General Evaluator", name: "Riyaz" },
				to: "the speech evaluators",
				toLabel: "the speech evaluators",
			},
		]);
	});

	it("names an unclaimed role's placeholder, exactly as the printed row does", () => {
		// An enabled-but-unclaimed role still has a slot, so both surfaces still
		// render the hand-off — print as "Toastmaster of the Day · — open —", and
		// the slide the same way. Suppressing it here would hide a cue the printed
		// agenda keeps.
		const open = handoffs({
			slots: [{ ...totd, assigneeName: null }, speaker],
		});
		expect(open).toEqual([
			{
				kind: "handoff",
				from: { role: "Toastmaster of the Day", name: "— open —" },
				to: "the speakers",
				toLabel: "the speakers",
			},
		]);
	});

	it("gives every hand-off it projects its own label in the jump grid", () => {
		// `slideLayout`'s HANDOFF_HEADER is keyed on `to` and falls back to a bare
		// "Hand-off" for an unmapped target — deliberately, so a new one cannot take
		// the deck down mid-meeting. Nothing tied that map to the targets this
		// function actually emits, though: slide-layout.test.ts asserts the four
		// keys as literals, the tests above assert the four `to` values as literals,
		// and neither notices the other. Add a fifth hand-off here and both lists
		// fail, both get updated, and the new slide lands in the overview grid as a
		// second row reading "Hand-off" — the exact ambiguity #363 exists to remove,
		// arriving silently. This is the assertion that says the fallback is
		// defensive rather than load-bearing.
		// Deliberately NOT `slideName` (#446), though the shape is the same: this maps
		// splash to the literal "splash" so an accidentally-splash hand-off trips the
		// `not.toContain("Hand-off")` check below, whereas `slideName` would return
		// the headline and hide it. Keep the copy; it is load-bearing here.
		const headers = handoffs({ geIntroducesFunctionaries: true }).map((s) => {
			const layout = slideLayout(s);
			return layout.chrome === "content" ? layout.header : "splash";
		});
		expect(headers).not.toContain("Hand-off");
		// Four labels for five slides: the two hand-offs INTO the General Evaluator
		// are the same transition and share one, which is why this is not 5.
		expect(new Set(headers).size).toBe(4);
	});

	it("binds by role key, so a renamed role keeps its hand-offs under the club's name", () => {
		const renamed = handoffs({
			slots: [
				{ ...totd, roleKey: "toastmaster_of_the_day", roleName: "Emcee" },
				speaker,
			],
		});
		expect(renamed).toEqual([
			{
				kind: "handoff",
				from: { role: "Emcee", name: "Faisal" },
				to: "the speakers",
				toLabel: "the speakers",
			},
		]);
	});
});

// Shared fixtures for the functionary + evaluation-session suites below.
const tmod = slot({
	id: "tm",
	roleName: "Toastmaster of the Day",
	category: "leadership",
	assigneeName: "Schinthia",
});
const ge = slot({
	id: "ge",
	roleName: "General Evaluator",
	category: "leadership",
	assigneeName: "Saiful Haque",
});
const grammarian = slot({
	id: "gr",
	roleName: "Grammarian",
	category: "functionary",
	assigneeName: "Mona",
});
const timer = slot({
	id: "ti",
	roleName: "Timer",
	category: "functionary",
	assigneeName: "Bilal",
});

/**
 * The functionary-intro slide (#367) — that beat of the run-of-show in slide
 * form: whoever owns it introduces the functionaries and each explains their
 * role. The default owner is the Toastmaster of the Day — the standard flow —
 * and the `geIntroducesFunctionaries` flag hands it to the General Evaluator
 * (MCF). This is the slide that used to be `geIntro`, which hardcoded MCF's
 * variant.
 */
describe("buildSlideDeck functionary intro (#367)", () => {
	it("is owned by the Toastmaster of the Day by default", () => {
		const slide = build({ slots: [tmod, ge, grammarian] }).find(
			(s) => s.kind === "functionaryIntro",
		);
		expect(slide).toMatchObject({
			owner: "Toastmaster of the Day",
			name: "Schinthia",
			team: [{ role: "Grammarian", name: "Mona" }],
		});
	});

	it("is owned by the General Evaluator under MCF's variant", () => {
		const slide = build({
			slots: [tmod, ge, grammarian],
			geIntroducesFunctionaries: true,
		}).find((s) => s.kind === "functionaryIntro");
		expect(slide).toMatchObject({
			owner: "General Evaluator",
			name: "Saiful Haque",
			team: [{ role: "Grammarian", name: "Mona" }],
		});
	});

	it("lists every functionary the club runs, open ones included", () => {
		const openTimer = slot({ id: "ti", roleName: "Timer", assigneeName: null });
		const slide = build({ slots: [tmod, grammarian, openTimer] }).find(
			(s) => s.kind === "functionaryIntro",
		);
		expect(slide).toMatchObject({
			team: [
				{ role: "Grammarian", name: "Mona" },
				{ role: "Timer", name: "— open —" },
			],
		});
	});

	it("is omitted when the club runs no functionary roles", () => {
		expect(kinds([tmod, ge])).not.toContain("functionaryIntro");
	});

	it("renders for a club whose functionaries are ALL club-invented (#371)", () => {
		// #368's disable lifecycle plus a club's own roles: the slide used to
		// vanish because the gate resolved against the four standard keys, while
		// its own `team` came from the category. Same definition now.
		const jokeMaster = slot({
			id: "jm",
			roleName: "Joke Master",
			assigneeName: "Nadia",
		});
		const slide = build({ slots: [tmod, jokeMaster] }).find(
			(s) => s.kind === "functionaryIntro",
		);
		expect(slide).toMatchObject({
			owner: "Toastmaster of the Day",
			team: [{ role: "Joke Master", name: "Nadia" }],
		});
	});

	it("is omitted when neither the owning role nor its cover has a slot", () => {
		// Default owner is the Toastmaster of the Day: a GE + functionaries is
		// not enough under the standard flow.
		expect(kinds([ge, grammarian])).not.toContain("functionaryIntro");
		// Under MCF's variant the owner is the General Evaluator — but the
		// Toastmaster covers that whole role (#363), so it takes losing BOTH.
		const mcf = build({
			slots: [grammarian],
			geIntroducesFunctionaries: true,
		}).map((s) => s.kind);
		expect(mcf).not.toContain("functionaryIntro");
	});

	it("is covered by the Toastmaster under MCF's variant when the club runs no General Evaluator (#363)", () => {
		// This slide is GE-owned under the variant, so it needs the same cover as
		// the GE's other slides. Without it a club with functionaries and no GE
		// projected no intro at all — and then projected the reports slide cueing
		// the very functionaries nobody had introduced.
		const deck = build({
			slots: [tmod, timer, grammarian],
			geIntroducesFunctionaries: true,
		});
		expect(deck.find((s) => s.kind === "functionaryIntro")).toMatchObject({
			owner: "Toastmaster of the Day",
			name: "Schinthia",
			team: [
				{ role: "Timer", name: "Bilal" },
				{ role: "Grammarian", name: "Mona" },
			],
		});
		// The slide it cues is owned by the same person, on the same deck.
		expect(deck.find((s) => s.kind === "functionaryReports")).toMatchObject({
			owner: "Toastmaster of the Day",
			name: "Schinthia",
		});
	});

	it("binds the owner by role key, so a renamed role still owns it (#368)", () => {
		const renamed = slot({
			id: "tm",
			roleName: "Master of Ceremonies",
			roleKey: "toastmaster_of_the_day",
			category: "leadership",
			assigneeName: "Schinthia",
		});
		const slide = build({ slots: [renamed, grammarian] }).find(
			(s) => s.kind === "functionaryIntro",
		);
		expect(slide).toMatchObject({ name: "Schinthia" });
	});

	it("sits before the speeches, where the old geIntro slide did", () => {
		expect(kinds([tmod, grammarian])).toEqual([
			"title",
			"toastmaster",
			"functionaryIntro",
			// This club runs no General Evaluator, so the Toastmaster covers the
			// role's closing slides (#363) — including the functionary reports, which
			// is what cues the Grammarian introduced one slide earlier. No
			// `evaluatorEvaluation`: the club runs no evaluators to evaluate.
			"functionaryReports",
			"generalEvaluation",
			"guestComments",
			"thankYou",
		]);
	});
});

/**
 * The functionary-reports slide (#367, absorbs #353). The General Evaluator
 * calls for the functionary reports, between evaluating the evaluators and the
 * overall meeting evaluation. Unaffected by `geIntroducesFunctionaries` — MCF's
 * closing sequence is everyone else's.
 */
describe("buildSlideDeck functionary reports (#367 / #353)", () => {
	it("lists the functionary roles that report and who holds each", () => {
		const slide = build({ slots: [ge, grammarian, timer] }).find(
			(s) => s.kind === "functionaryReports",
		);
		expect(slide).toMatchObject({
			name: "Saiful Haque",
			team: [
				{ role: "Grammarian", name: "Mona" },
				{ role: "Timer", name: "Bilal" },
			],
		});
	});

	it("comes immediately before the general evaluation", () => {
		const ks = kinds([tmod, ge, grammarian]);
		expect(ks.indexOf("functionaryReports")).toBe(
			ks.indexOf("generalEvaluation") - 1,
		);
	});

	it("follows the evaluations and the Best Evaluator vote", () => {
		const speaker = slot({
			id: "sp1",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			assigneeName: "Rehanna Khan",
		});
		const evaluator = slot({
			id: "ev1",
			roleName: "Evaluator",
			category: "evaluator",
			assigneeName: "Faisal Ali",
			evaluatesSlotId: "sp1",
			evaluates: { speakerName: "Rehanna Khan" },
		});
		expect(kinds([tmod, ge, grammarian, speaker, evaluator])).toEqual([
			"title",
			"toastmaster",
			"functionaryIntro",
			// The Toastmaster introduces the speakers (#363).
			"handoff",
			"speech",
			"voteSpeaker",
			// No Table Topics segment, so the Toastmaster — who never gave the room
			// away — introduces the General Evaluator, who then introduces the
			// evaluators. Both hand-offs mirror their beats' fallbacks.
			"handoff",
			"handoff",
			"evaluation",
			"voteEvaluator",
			"evaluatorEvaluation",
			"functionaryReports",
			"generalEvaluation",
			"awards",
			"guestComments",
			"thankYou",
		]);
	});

	it("is omitted when the club runs no functionary roles", () => {
		expect(kinds([tmod, ge])).not.toContain("functionaryReports");
	});

	it("omits the Vote Counter, who is a functionary but gives no report (#371)", () => {
		const voteCounter = slot({
			id: "vc",
			roleName: "Vote Counter",
			assigneeName: "Omar",
		});
		const slide = build({ slots: [ge, grammarian, voteCounter] }).find(
			(s) => s.kind === "functionaryReports",
		);
		expect(slide).toMatchObject({
			team: [{ role: "Grammarian", name: "Mona" }],
		});
		// …and with nobody else to report, the slide goes away entirely — the same
		// signal that beat's gate reads, so print and deck can't disagree.
		expect(kinds([tmod, ge, voteCounter])).not.toContain("functionaryReports");
		// The Vote Counter is still introduced: they ARE a functionary.
		expect(kinds([tmod, ge, voteCounter])).toContain("functionaryIntro");
	});

	it("renders for a club whose only functionary is a club-invented one (#371)", () => {
		const jokeMaster = slot({
			id: "jm",
			roleName: "Joke Master",
			assigneeName: "Nadia",
		});
		const slide = build({ slots: [ge, jokeMaster] }).find(
			(s) => s.kind === "functionaryReports",
		);
		expect(slide).toMatchObject({
			team: [{ role: "Joke Master", name: "Nadia" }],
		});
	});

	it("moves to the Toastmaster when there is no General Evaluator (#363)", () => {
		// This used to assert the slide was OMITTED — which meant a club running a
		// Grammarian and no GE introduced them at the top of the meeting and never
		// called for their report. The Toastmaster covers the role instead, and the
		// slide says so rather than announcing "General Evaluator: Schinthia".
		const slide = build({ slots: [tmod, grammarian] }).find(
			(s) => s.kind === "functionaryReports",
		);
		expect(slide).toMatchObject({
			owner: "Toastmaster of the Day",
			name: "Schinthia",
			team: [{ role: "Grammarian", name: "Mona" }],
		});
	});

	it("is omitted when there is neither a General Evaluator nor a Toastmaster", () => {
		// The fallback has nowhere to fall back to, so both surfaces drop it.
		expect(kinds([grammarian])).not.toContain("functionaryReports");
	});

	it("renders identically under MCF's variant, apart from the opening GE hand-off the swap needs", () => {
		const standard = kinds([tmod, ge, grammarian]);
		const mcf = build({
			slots: [tmod, ge, grammarian],
			geIntroducesFunctionaries: true,
		}).map((s) => s.kind);
		// The flag adds exactly one slide — the Toastmaster introducing the General
		// Evaluator before handing them the functionary intro (#363) — and moves
		// nothing else. The functionary-reports stretch this suite is about is
		// untouched.
		expect(mcf.filter((k) => k !== "handoff")).toEqual(
			standard.filter((k) => k !== "handoff"),
		);
		expect(mcf.filter((k) => k === "handoff")).toHaveLength(
			standard.filter((k) => k === "handoff").length + 1,
		);
	});
});

describe("buildSlideDeck evaluation session", () => {
	const speaker = slot({
		id: "sp1",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: 0,
		assigneeName: "Rehanna Khan",
	});
	const evaluator = slot({
		id: "ev1",
		roleName: "Evaluator",
		category: "evaluator",
		slotIndex: 0,
		assigneeName: "Faisal Ali",
		evaluatesSlotId: "sp1",
		evaluates: { speakerName: "Rehanna Khan" },
	});

	it("orders the full evaluation session correctly", () => {
		expect(kinds([ge, speaker, evaluator])).toEqual([
			"title",
			// No Toastmaster of the Day, so the speakers' hand-off has no owner and
			// no `renderUnowned` — the printed row is dropped too (#363).
			"speech",
			"voteSpeaker",
			// The General Evaluator introduces the evaluators. The hand-off INTO the
			// GE is gone with the Toastmaster: its fallback owner is missing too.
			"handoff",
			"evaluation",
			"voteEvaluator",
			// The evaluator-evaluation beat — the GE evaluates the evaluators, AFTER
			// the Best-Evaluator vote, where the run sheet puts it. The old
			// `evalIntro` slide sat before the evaluations, matching no beat at all.
			"evaluatorEvaluation",
			"generalEvaluation",
			"awards",
			"guestComments",
			"thankYou",
		]);
	});

	it("evaluation slide pairs evaluator to the speaker they evaluate", () => {
		const slide = build({ slots: [ge, speaker, evaluator] }).find(
			(s) => s.kind === "evaluation",
		);
		expect(slide).toMatchObject({
			evaluator: "Faisal Ali",
			speaker: "Rehanna Khan",
			// The speech-evaluation beat's budget, not a second opinion about it
			// (#356). The deck used to hardcode "2–3 minutes" while the run sheet
			// booked 3.
			time: "3 minutes",
		});
	});

	it("quotes the beat's budget, so a retimed beat moves the slide (#356)", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: false });
		const deck = build({ slots: [ge, speaker, evaluator] });
		expect(deck.find((s) => s.kind === "evaluation")).toMatchObject({
			time: beatDuration(template, "evaluation"),
		});
		expect(deck.find((s) => s.kind === "evaluatorEvaluation")).toMatchObject({
			time: beatDuration(template, "evaluatorEvaluation"),
		});
		expect(deck.find((s) => s.kind === "generalEvaluation")).toMatchObject({
			time: beatDuration(template, "generalEvaluation"),
		});
	});

	it("omits GE slides when no General Evaluator slot exists", () => {
		expect(kinds([])).not.toContain("generalEvaluation");
		expect(kinds([])).not.toContain("functionaryReports");
		expect(kinds([])).not.toContain("evaluatorEvaluation");
	});

	/**
	 * This replaces "gates the evaluator evaluation on the General Evaluator, NOT
	 * on the evaluators (#367)", which pinned the decision #363 reverses. The
	 * slide needs BOTH: somebody to give it (the GE, or the Toastmaster covering
	 * the role) and somebody to have evaluated. #367's symmetry argument — a GE
	 * with no evaluators still gets the slide — was defending wrong copy: there
	 * is nothing to evaluate, whoever is holding the room.
	 */
	it("needs an owner AND evaluators, and never names a role the club does not run", () => {
		// Evaluators but nobody to run it: no General Evaluator and no Toastmaster
		// of the Day to cover. The deck used to gate this slide on the EVALUATORS
		// and fall back to the literal role name, projecting "General Evaluator:
		// General Evaluator".
		const noOwner = build({ slots: [speaker, evaluator] });
		expect(noOwner.map((s) => s.kind)).not.toContain("evaluatorEvaluation");
		expect(JSON.stringify(noOwner)).not.toContain("General Evaluator");

		// An owner but nothing to evaluate — the case #367 kept and #363 drops.
		expect(kinds([ge])).not.toContain("evaluatorEvaluation");
		expect(kinds([tmod])).not.toContain("evaluatorEvaluation");

		// Both present ⇒ the slide is there. Not vacuous: the two negatives above
		// would pass if the slide never rendered at all.
		expect(kinds([ge, speaker, evaluator])).toContain("evaluatorEvaluation");
		// …and the Toastmaster covering the role satisfies the owner half (#363).
		expect(kinds([tmod, speaker, evaluator])).toContain("evaluatorEvaluation");
	});

	it("the evaluator-evaluation slide names the GE holder, or the open placeholder when unclaimed", () => {
		const openGe = slot({
			id: "ge",
			roleName: "General Evaluator",
			category: "leadership",
			assigneeName: null,
		});
		expect(
			build({ slots: [ge, speaker, evaluator] }).find(
				(s) => s.kind === "evaluatorEvaluation",
			),
		).toMatchObject({
			owner: "General Evaluator",
			name: "Saiful Haque",
			time: "2 minutes",
		});
		expect(
			build({ slots: [openGe, speaker, evaluator] }).find(
				(s) => s.kind === "evaluatorEvaluation",
			),
		).toMatchObject({ owner: "General Evaluator", name: "— open —" });
	});

	it("the Best-Evaluator vote carries whether the club runs a Timer (#367)", () => {
		// The Best-Evaluator vote beat's fallback drops the timer's-report clause
		// when there is no Timer; the slide's copy has to adapt on the same signal.
		const voteOf = (slots: AgendaSlot[]) =>
			build({ slots }).find((s) => s.kind === "voteEvaluator");
		expect(voteOf([speaker, evaluator])).toMatchObject({ hasTimer: false });
		expect(voteOf([speaker, evaluator, timer])).toMatchObject({
			hasTimer: true,
		});
	});
});

/**
 * The Toastmaster of the Day covers the whole General Evaluator role at a club
 * that runs no GE (#363). The deck has to mirror the run sheet's five relocated
 * beats exactly — `agenda-parity.test.ts` proves the SEQUENCES match; this suite
 * is about the COPY, which ordering parity cannot see.
 *
 * The failure it guards against is specific: three of these slides used to carry
 * only a `name`, and `slide-layout.ts` hardcoded the literal "General Evaluator"
 * beside it. Rendering them for a covering Toastmaster without an `owner` would
 * have projected "General Evaluator: Schinthia" — a role nobody in the room
 * holds, which is the exact defect on the printed side that started #363.
 */
describe("the Toastmaster covers the General Evaluator's role — deck (#363)", () => {
	const speaker = slot({
		id: "sp1",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "Rehanna Khan",
	});
	const evaluator = slot({
		id: "ev1",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Faisal Ali",
		evaluatesSlotId: "sp1",
		evaluates: { speakerName: "Rehanna Khan" },
	});
	/** A full club minus its General Evaluator. */
	const noGe = [tmod, grammarian, timer, speaker, evaluator];

	it("gives all three closing slides to the Toastmaster, naming the right role", () => {
		const deck = build({ slots: noGe });
		expect(deck.find((s) => s.kind === "evaluatorEvaluation")).toMatchObject({
			owner: "Toastmaster of the Day",
			name: "Schinthia",
		});
		expect(deck.find((s) => s.kind === "functionaryReports")).toMatchObject({
			owner: "Toastmaster of the Day",
			name: "Schinthia",
			team: [{ role: "Grammarian", name: "Mona" }, { role: "Timer" }],
		});
		// No `name` on this one: the slide names the ROLE only (`slideLayout` has
		// never shown the holder), so it carries no holder to assert.
		expect(deck.find((s) => s.kind === "generalEvaluation")).toMatchObject({
			owner: "Toastmaster of the Day",
		});
	});

	it("hands the Best-Evaluator vote to the Toastmaster too", () => {
		expect(
			build({ slots: noGe }).find((s) => s.kind === "voteEvaluator"),
		).toMatchObject({
			caller: { role: "Toastmaster of the Day", name: "Schinthia" },
			hasTimer: true,
		});
	});

	it("never projects the words 'General Evaluator' at a club that runs none", () => {
		// Through `slideLayout`, i.e. the text actually rendered on the wall and
		// exported to .pptx — not just the slide data. This is the assertion that
		// would have caught a hardcoded header.
		const rendered = build({ slots: noGe }).map((s) =>
			JSON.stringify(slideLayout(s)),
		);
		expect(rendered.filter((t) => t.includes("General Evaluator"))).toEqual([]);
		// Not vacuous: the same club WITH a General Evaluator says it plenty.
		const withGe = build({ slots: [...noGe, ge] }).map((s) =>
			JSON.stringify(slideLayout(s)),
		);
		expect(
			withGe.filter((t) => t.includes("General Evaluator")).length,
		).toBeGreaterThan(0);
	});

	it("drops all three when there is no Toastmaster to cover either", () => {
		const ks = kinds([grammarian, timer, speaker, evaluator]);
		expect(ks).not.toContain("evaluatorEvaluation");
		expect(ks).not.toContain("functionaryReports");
		expect(ks).not.toContain("generalEvaluation");
	});

	it("names the covering role as the CLUB names it (#368)", () => {
		const renamed = slot({
			id: "tm",
			roleKey: "toastmaster_of_the_day",
			roleName: "Master of Ceremonies",
			category: "leadership",
			assigneeName: "Schinthia",
		});
		expect(
			build({ slots: [renamed, grammarian] }).find(
				(s) => s.kind === "functionaryReports",
			),
		).toMatchObject({ owner: "Master of Ceremonies", name: "Schinthia" });
	});
});

describe("buildSlideDeck awards + reminders", () => {
	const speaker = slot({
		id: "sp1",
		isSpeakerRole: true,
		roleName: "Speaker",
		category: "speaker",
		assigneeName: "Rehanna Khan",
	});
	const tt = slot({
		id: "tt",
		roleName: "Table Topics Master",
		assigneeName: "Rasheed",
	});
	const evaluator = slot({
		id: "ev",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Faisal",
	});

	it("awards lists only categories whose sections exist", () => {
		const slide = build({ slots: [speaker, tt, evaluator] }).find(
			(s) => s.kind === "awards",
		);
		expect(slide).toMatchObject({
			categories: ["Best Table Topic", "Best Evaluator", "Best Speaker"],
		});

		const speakerOnly = build({ slots: [speaker] }).find(
			(s) => s.kind === "awards",
		);
		expect(speakerOnly).toMatchObject({ categories: ["Best Speaker"] });
	});

	it("no awards slide when no scored sections exist", () => {
		expect(kinds([])).not.toContain("awards");
	});

	it("projects guest comments between the awards and the announcements (#352)", () => {
		const deck = build({
			slots: [speaker, tt, evaluator],
			meeting: { ...meeting, reminders: "Choose a learning path." },
		});
		const kindsOf = deck.map((s) => s.kind);
		expect(kindsOf.indexOf("guestComments")).toBe(
			kindsOf.indexOf("awards") + 1,
		);
		expect(kindsOf.indexOf("reminders")).toBe(
			kindsOf.indexOf("guestComments") + 1,
		);
	});

	it("guest comments are projected even for a club that scores nothing (#352)", () => {
		// The beat is ungated — every meeting can have guests — so the slide is
		// too, or the deck skips a segment the printed agenda books time for.
		expect(kinds([])).toEqual(["title", "guestComments", "thankYou"]);
	});

	it("reminders slide only when reminders non-blank, just before thankYou", () => {
		expect(kinds([])).not.toContain("reminders");
		const deck = build({
			meeting: { ...meeting, reminders: "Choose a learning path." },
		});
		expect(deck.map((s) => s.kind)).toEqual([
			"title",
			"guestComments",
			"reminders",
			"thankYou",
		]);
		expect(deck[2]).toMatchObject({
			kind: "reminders",
			text: "Choose a learning path.",
		});
	});

	it("thankYou carries nextMeetingAt + timezone when provided", () => {
		const next = new Date("2026-07-23T23:45:00Z");
		expect(build({ nextMeetingAt: next }).at(-1)).toMatchObject({
			kind: "thankYou",
			nextMeetingAt: next,
			timezone: "America/Chicago",
		});
	});
});

describe("buildSlideDeck full meeting ordering", () => {
	const slots: AgendaSlot[] = [
		slot({ roleName: "Toastmaster of the Day", assigneeName: "Schinthia" }),
		slot({
			id: "ge",
			roleName: "General Evaluator",
			category: "leadership",
			assigneeName: "Saiful",
		}),
		slot({ id: "gr", roleName: "Grammarian", assigneeName: "Mona" }),
		slot({
			id: "sp1",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 0,
			assigneeName: "Rehanna",
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot({
			id: "sp2",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 1,
			assigneeName: "Sudheer",
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot({
			id: "tt",
			roleName: "Table Topics Master",
			assigneeName: "Rasheed",
		}),
		slot({
			id: "ev1",
			roleName: "Evaluator",
			category: "evaluator",
			slotIndex: 0,
			assigneeName: "Faisal",
			evaluatesSlotId: "sp1",
			evaluates: { speakerName: "Rehanna" },
		}),
		slot({
			id: "ev2",
			roleName: "Evaluator",
			category: "evaluator",
			slotIndex: 1,
			assigneeName: "Priya",
			evaluatesSlotId: "sp2",
			evaluates: { speakerName: "Sudheer" },
		}),
	];
	const full: MeetingForDeck = {
		...meeting,
		theme: "A Fresh Start",
		wordOfTheDay: "Momentum",
		wodDefinition: "impetus gained by a moving object",
		reminders: "Choose a learning path.",
	};

	it("produces the canonical slide sequence", () => {
		expect(build({ meeting: full, slots }).map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			// #354: the Word of the Day belongs to the Toastmaster's opening, not
			// several beats downstream of the functionary intro.
			"toastmasterIntro",
			"wordOfDay",
			"functionaryIntro",
			// Each 0-minute hand-off beat gets its slide (#363), in the run sheet's
			// order: to the speakers, to the Table Topics Master, to the General
			// Evaluator, to the speech evaluators.
			"handoff",
			"speech",
			"speech",
			"voteSpeaker",
			"handoff",
			"tableTopics",
			"voteTableTopics",
			"handoff",
			"handoff",
			"evaluation",
			"evaluation",
			"voteEvaluator",
			"evaluatorEvaluation",
			"functionaryReports",
			"generalEvaluation",
			"awards",
			// #352: guest comments come between the awards and the closing
			// announcements, where the room actually takes them.
			"guestComments",
			"reminders",
			"thankYou",
		]);
	});

	it("MCF's variant differs in who owns the functionary intro, plus the hand-off that swap needs", () => {
		const standard = build({ meeting: full, slots });
		const mcf = build({
			meeting: full,
			slots,
			geIntroducesFunctionaries: true,
		});
		// One extra slide, in one place: the Toastmaster introducing the General
		// Evaluator immediately before the intro the swap handed them (#363).
		const at = mcf.findIndex((s) => s.kind === "functionaryIntro");
		expect(mcf[at - 1]).toEqual({
			kind: "handoff",
			from: { role: "Toastmaster of the Day", name: "Schinthia" },
			to: "the General Evaluator",
			toLabel: "the General Evaluator",
		});
		expect(
			[...mcf.slice(0, at - 1), ...mcf.slice(at)].map((s) => s.kind),
		).toEqual(standard.map((s) => s.kind));
		expect(mcf.find((s) => s.kind === "functionaryIntro")).toMatchObject({
			owner: "General Evaluator",
			name: "Saiful",
		});
	});
});
