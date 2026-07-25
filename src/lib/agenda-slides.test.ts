import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
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

/** `buildSlideDeck` with the standard fixtures, overridden per test. */
const build = (over: Partial<SlideDeckInput> = {}) =>
	buildSlideDeck({ meeting, club, slots: [], ...over });

const kinds = (slots: AgendaSlot[] = []) => build({ slots }).map((s) => s.kind);

describe("buildSlideDeck anchors", () => {
	it("always emits title, toastmaster, thankYou — even with no slots", () => {
		expect(kinds([])).toEqual(["title", "toastmaster", "thankYou"]);
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

	it("toastmaster slide shows the assignee, else the open placeholder", () => {
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
		expect(build()[1]).toMatchObject({
			kind: "toastmaster",
			name: "— open —",
		});
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
			"toastmaster",
			"speech",
			"speech",
			"voteSpeaker",
			"awards",
			"thankYou",
		]);
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
			"toastmaster",
			"tableTopics",
			"voteTableTopics",
			"awards",
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
 * The functionary-intro slide (#367). Beat 4 of the run-of-show in slide form:
 * whoever owns it introduces the functionaries and each explains their role.
 * The default owner is the Toastmaster of the Day — the standard flow — and the
 * `geIntroducesFunctionaries` flag hands it to the General Evaluator (MCF).
 * This is the slide that used to be `geIntro`, which hardcoded MCF's variant.
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
			"thankYou",
		]);
	});
});

/**
 * The functionary-reports slide (#367, absorbs #353). Beat 12: the General
 * Evaluator calls for the functionary reports, between evaluating the
 * evaluators and the overall meeting evaluation. Unaffected by
 * `geIntroducesFunctionaries` — MCF's closing sequence is everyone else's.
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
			"evalIntro",
			"evaluation",
			"voteEvaluator",
			"functionaryReports",
			"generalEvaluation",
			"awards",
			"thankYou",
		]);
	});

	it("is omitted when the club runs no functionary roles", () => {
		expect(kinds([tmod, ge])).not.toContain("functionaryReports");
	});

	it("is omitted when there is no General Evaluator", () => {
		expect(kinds([tmod, grammarian])).not.toContain("functionaryReports");
	});

	it("renders identically under MCF's variant — the flag moves beat 4 only", () => {
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
			"toastmaster",
			"speech",
			"voteSpeaker",
			"evalIntro",
			"evaluation",
			"voteEvaluator",
			"generalEvaluation",
			"awards",
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
			time: "2–3 minutes",
		});
	});

	it("omits GE slides when no General Evaluator slot exists", () => {
		expect(kinds([])).not.toContain("generalEvaluation");
		expect(kinds([])).not.toContain("functionaryReports");
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

	it("reminders slide only when reminders non-blank, just before thankYou", () => {
		expect(kinds([])).not.toContain("reminders");
		const deck = build({
			meeting: { ...meeting, reminders: "Choose a learning path." },
		});
		expect(deck.map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
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
			"toastmasterIntro",
			"functionaryIntro",
			"wordOfDay",
			"speech",
			"speech",
			"voteSpeaker",
			"tableTopics",
			"voteTableTopics",
			"evalIntro",
			"evaluation",
			"evaluation",
			"voteEvaluator",
			"functionaryReports",
			"generalEvaluation",
			"awards",
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
