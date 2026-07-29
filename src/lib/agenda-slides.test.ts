import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import { beatDuration, buildRunOfShow } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
	type SlideDeckInput,
} from "./agenda-slides";

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

	it("is omitted when the owning role has no slot", () => {
		// Default owner is the Toastmaster of the Day: a GE + functionaries is
		// not enough under the standard flow.
		expect(kinds([ge, grammarian])).not.toContain("functionaryIntro");
		// …and symmetrically, under MCF's variant a Toastmaster is not enough.
		const mcf = build({
			slots: [tmod, grammarian],
			geIntroducesFunctionaries: true,
		}).map((s) => s.kind);
		expect(mcf).not.toContain("functionaryIntro");
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
			"speech",
			"voteSpeaker",
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

	it("is omitted when there is no General Evaluator", () => {
		expect(kinds([tmod, grammarian])).not.toContain("functionaryReports");
	});

	it("renders identically under MCF's variant — the flag moves the functionary intro only", () => {
		const standard = kinds([tmod, ge, grammarian]);
		const mcf = build({
			slots: [tmod, ge, grammarian],
			geIntroducesFunctionaries: true,
		}).map((s) => s.kind);
		expect(mcf).toEqual(standard);
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
			"speech",
			"voteSpeaker",
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

	it("gates the evaluator evaluation on the General Evaluator, NOT on the evaluators (#367)", () => {
		// Spec: no General Evaluator ⇒ the evaluator evaluation, the functionary
		// reports and the overall evaluation all vanish, and nothing replaces the
		// overall meeting evaluation. Before this fix the deck gated the slide on
		// the EVALUATORS and fell back to the literal role name, so a club with
		// evaluators and no GE projected "General Evaluator: General Evaluator".
		const noGe = build({ slots: [speaker, evaluator] });
		expect(noGe.map((s) => s.kind)).not.toContain("evaluatorEvaluation");
		expect(JSON.stringify(noGe)).not.toContain("General Evaluator");

		// …and symmetrically, a GE with no evaluators still gives the slide.
		expect(kinds([ge])).toContain("evaluatorEvaluation");
	});

	it("the evaluator-evaluation slide names the GE holder, or the open placeholder when unclaimed", () => {
		const openGe = slot({
			id: "ge",
			roleName: "General Evaluator",
			category: "leadership",
			assigneeName: null,
		});
		expect(
			build({ slots: [ge] }).find((s) => s.kind === "evaluatorEvaluation"),
		).toMatchObject({ name: "Saiful Haque", time: "2 minutes" });
		expect(
			build({ slots: [openGe] }).find((s) => s.kind === "evaluatorEvaluation"),
		).toMatchObject({ name: "— open —" });
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
			"speech",
			"speech",
			"voteSpeaker",
			"tableTopics",
			"voteTableTopics",
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

	it("MCF's variant differs only in who owns the functionary intro", () => {
		const standard = build({ meeting: full, slots });
		const mcf = build({
			meeting: full,
			slots,
			geIntroducesFunctionaries: true,
		});
		expect(mcf.map((s) => s.kind)).toEqual(standard.map((s) => s.kind));
		expect(mcf.find((s) => s.kind === "functionaryIntro")).toMatchObject({
			owner: "General Evaluator",
			name: "Saiful",
		});
	});
});
