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
		expect(withTmod[1]).toMatchObject({ kind: "toastmaster", name: "Schinthia" });
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

describe("buildSlideDeck theme + word of the day", () => {
	it("omits theme + wordOfDay when both blank", () => {
		expect(kinds([])).not.toContain("theme");
		expect(kinds([])).not.toContain("wordOfDay");
	});

	it("emits theme slide only when theme set", () => {
		const deck = buildSlideDeck({ ...meeting, theme: "A Fresh Start" }, club, []);
		expect(deck.map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			"theme",
			"thankYou",
		]);
		expect(deck[2]).toMatchObject({ kind: "theme", theme: "A Fresh Start" });
	});

	it("wordOfDay slide includes definition + example only when present", () => {
		const full = buildSlideDeck(
			{
				...meeting,
				wordOfTheDay: "Momentum",
				wodDefinition: "impetus gained by a moving object",
				wodExample: "The momentum of the river keeps moving forward.",
			},
			club,
			[],
		);
		expect(full.find((s) => s.kind === "wordOfDay")).toMatchObject({
			word: "Momentum",
			definition: "impetus gained by a moving object",
			example: "The momentum of the river keeps moving forward.",
		});

		const wordOnly = buildSlideDeck({ ...meeting, wordOfTheDay: "Momentum" }, club, []);
		expect(wordOnly.find((s) => s.kind === "wordOfDay")).toMatchObject({
			word: "Momentum",
			definition: null,
			example: null,
		});
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
			"thankYou",
		]);
	});

	it("speech slide carries speaker, title, level, and real time range", () => {
		const speech = buildSlideDeck(meeting, club, speakers).find(
			(s) => s.kind === "speech",
		);
		expect(speech).toMatchObject({
			label: "Speech 1",
			speaker: "Rehanna Khan",
			title: "A Tasteful Historic Profile",
			projectLevel: "Level 1",
			time: "5–7 minutes",
		});
	});

	it("vote slide lists assigned speaker names, skipping open slots", () => {
		const withOpen = [...speakers, slot({
			id: "sp3",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 2,
			assigneeName: null,
		})];
		const vote = buildSlideDeck(meeting, club, withOpen).find(
			(s) => s.kind === "voteSpeaker",
		);
		expect(vote).toMatchObject({ names: ["Rehanna Khan", "Sudheer Isanaka"] });
	});

	it("single speaker uses unnumbered label", () => {
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
