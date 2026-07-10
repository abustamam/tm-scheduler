import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
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

const kinds = (slots: AgendaSlot[] = []) =>
	buildSlideDeck(meeting, club, slots).map((s) => s.kind);

describe("buildSlideDeck anchors", () => {
	it("always emits title, toastmaster, thankYou — even with no slots", () => {
		expect(kinds([])).toEqual(["title", "toastmaster", "thankYou"]);
	});

	it("title slide carries club identity + schedule time", () => {
		const [title] = buildSlideDeck(meeting, club, []);
		expect(title).toMatchObject({
			kind: "title",
			clubName: "MCF Toastmasters Club",
			clubNumber: "28677176",
			district: "District 39",
			timezone: "America/Chicago",
		});
	});

	it("toastmaster slide shows the assignee, else the open placeholder", () => {
		const withTmod = buildSlideDeck(meeting, club, [
			slot({ roleName: "Toastmaster of the Day", assigneeName: "Schinthia" }),
		]);
		expect(withTmod[1]).toMatchObject({
			kind: "toastmaster",
			name: "Schinthia",
		});
		expect(buildSlideDeck(meeting, club, [])[1]).toMatchObject({
			kind: "toastmaster",
			name: "— open —",
		});
	});

	it("thankYou carries the club meeting schedule", () => {
		const deck = buildSlideDeck(meeting, club, []);
		expect(deck.at(-1)).toMatchObject({
			kind: "thankYou",
			meetingSchedule: "2nd & 4th Thursday",
		});
	});
});

describe("buildSlideDeck toastmaster intro + word of the day", () => {
	it("merges theme + WOD word into one toastmasterIntro slide", () => {
		const deck = buildSlideDeck(
			{ ...meeting, theme: "Unity", wordOfTheDay: "Synergy" },
			club,
			[],
		);
		const intro = deck.find((s) => s.kind === "toastmasterIntro");
		expect(intro).toMatchObject({ theme: "Unity", word: "Synergy" });
	});

	it("emits a standalone wordOfDay slide only when a definition/example exists", () => {
		const withDef = buildSlideDeck(
			{ ...meeting, wordOfTheDay: "Synergy", wodDefinition: "cooperation" },
			club,
			[],
		);
		expect(withDef.some((s) => s.kind === "wordOfDay")).toBe(true);

		const wordOnly = buildSlideDeck(
			{ ...meeting, wordOfTheDay: "Synergy" },
			club,
			[],
		);
		expect(wordOnly.some((s) => s.kind === "wordOfDay")).toBe(false);
		expect(wordOnly.some((s) => s.kind === "toastmasterIntro")).toBe(true);
	});

	it("omits toastmasterIntro when neither theme nor WOD is set", () => {
		const deck = buildSlideDeck(meeting, club, []);
		expect(deck.some((s) => s.kind === "toastmasterIntro")).toBe(false);
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
		const ks = buildSlideDeck(meeting, club, speakers).map((s) => s.kind);
		expect(ks).toEqual([
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
		const speech = buildSlideDeck(meeting, club, speakers).find(
			(s) => s.kind === "speech",
		);
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
		const vote = buildSlideDeck(meeting, club, withOpen).find(
			(s) => s.kind === "voteSpeaker",
		);
		expect(vote).toMatchObject({ names: ["Rehanna Khan", "Sudheer Isanaka"] });
	});

	it("labels multiple speeches with ordinal words; a lone speech is 'Speech'", () => {
		const two = buildSlideDeck(meeting, club, speakers).filter(
			(s) => s.kind === "speech",
		);
		expect(two.map((s) => (s as { label: string }).label)).toEqual([
			"First Speech",
			"Second Speech",
		]);
		const one = buildSlideDeck(meeting, club, [speakers[0]]).find(
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
		const ks = buildSlideDeck(meeting, club, [tt]).map((s) => s.kind);
		expect(ks).toEqual([
			"title",
			"toastmaster",
			"tableTopics",
			"voteTableTopics",
			"awards",
			"thankYou",
		]);
	});

	it("table topics slide has master + hardcoded standard timing", () => {
		const slide = buildSlideDeck(meeting, club, [tt]).find(
			(s) => s.kind === "tableTopics",
		);
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

describe("buildSlideDeck evaluation session", () => {
	const ge = slot({
		id: "ge",
		roleName: "General Evaluator",
		category: "evaluator",
		assigneeName: "Saiful Haque",
	});
	const grammarian = slot({
		id: "gr",
		roleName: "Grammarian",
		category: "functionary",
		assigneeName: "Mona",
	});
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

	it("emits geIntro with the GE's functionary team via buildLegend", () => {
		const slide = buildSlideDeck(meeting, club, [ge, grammarian]).find(
			(s) => s.kind === "geIntro",
		);
		expect(slide).toMatchObject({
			name: "Saiful Haque",
			team: [{ role: "Grammarian", name: "Mona" }],
		});
	});

	it("orders the full evaluation session correctly", () => {
		const ks = buildSlideDeck(meeting, club, [ge, speaker, evaluator]).map(
			(s) => s.kind,
		);
		expect(ks).toEqual([
			"title",
			"toastmaster",
			"geIntro",
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
		const slide = buildSlideDeck(meeting, club, [ge, speaker, evaluator]).find(
			(s) => s.kind === "evaluation",
		);
		expect(slide).toMatchObject({
			evaluator: "Faisal Ali",
			speaker: "Rehanna Khan",
			time: "2–3 minutes",
		});
	});

	it("omits GE slides when no General Evaluator slot exists", () => {
		expect(kinds([])).not.toContain("geIntro");
		expect(kinds([])).not.toContain("generalEvaluation");
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
		const slide = buildSlideDeck(meeting, club, [speaker, tt, evaluator]).find(
			(s) => s.kind === "awards",
		);
		expect(slide).toMatchObject({
			categories: ["Best Table Topic", "Best Evaluator", "Best Speaker"],
		});

		const speakerOnly = buildSlideDeck(meeting, club, [speaker]).find(
			(s) => s.kind === "awards",
		);
		expect(speakerOnly).toMatchObject({ categories: ["Best Speaker"] });
	});

	it("no awards slide when no scored sections exist", () => {
		expect(kinds([])).not.toContain("awards");
	});

	it("reminders slide only when reminders non-blank, just before thankYou", () => {
		expect(kinds([])).not.toContain("reminders");
		const deck = buildSlideDeck(
			{ ...meeting, reminders: "Choose a learning path." },
			club,
			[],
		);
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
		const deck = buildSlideDeck(meeting, club, [], next);
		expect(deck.at(-1)).toMatchObject({
			kind: "thankYou",
			nextMeetingAt: next,
			timezone: "America/Chicago",
		});
	});
});

describe("buildSlideDeck full meeting ordering", () => {
	it("produces the canonical slide sequence", () => {
		const slots: AgendaSlot[] = [
			slot({ roleName: "Toastmaster of the Day", assigneeName: "Schinthia" }),
			slot({
				id: "ge",
				roleName: "General Evaluator",
				category: "evaluator",
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
		expect(buildSlideDeck(full, club, slots).map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			"toastmasterIntro",
			"geIntro",
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
			"generalEvaluation",
			"awards",
			"reminders",
			"thankYou",
		]);
	});
});
