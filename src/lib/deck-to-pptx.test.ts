import PptxGenJS from "pptxgenjs";
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
	type Slide,
} from "./agenda-slides";
import { deckToPptx, pptxFileName, slideContent } from "./deck-to-pptx";

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
	theme: "A Fresh Start",
	wordOfTheDay: "Momentum",
	wodDefinition: "impetus gained by a moving object",
	wodExample: "The momentum of the river keeps moving forward.",
	reminders: "Choose a learning path.\nBring a guest.",
};

const club: ClubForDeck = {
	name: "MCF Toastmasters Club",
	clubNumber: "28677176",
	district: "District 39",
	timezone: "America/Chicago",
	meetingSchedule: "2nd & 4th Thursday",
};

// A representative full meeting exercising every slide kind.
const fullSlots: AgendaSlot[] = [
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
		assigneeName: "Sudheer",
		minMinutes: 5,
		maxMinutes: 7,
	}),
	slot({ id: "tt", roleName: "Table Topics Master", assigneeName: "Rasheed" }),
	slot({
		id: "ev1",
		roleName: "Evaluator",
		category: "evaluator",
		slotIndex: 0,
		assigneeName: "Faisal",
		evaluatesSlotId: "sp1",
		evaluates: { speakerName: "Rehanna" },
	}),
];

const contentByKind = (deck: Slide[]) => {
	const map = new Map<Slide["kind"], ReturnType<typeof slideContent>>();
	for (const s of deck) map.set(s.kind, slideContent(s));
	return map;
};

describe("slideContent per kind", () => {
	const deck = buildSlideDeck(meeting, club, fullSlots);
	const by = contentByKind(deck);

	it("covers every kind the deck can produce", () => {
		// A full meeting exercises the whole union except the vote/thankYou
		// anchors, which we assert individually below.
		expect(by.get("title")).toMatchObject({ title: "MCF Toastmasters Club" });
		expect(by.get("title")?.eyebrow).toContain("District 39");
		expect(by.get("title")?.eyebrow).toContain("Club #28677176");
	});

	it("toastmaster shows assignee under the role eyebrow", () => {
		expect(by.get("toastmaster")).toMatchObject({
			eyebrow: "Toastmaster of the Day",
			title: "Schinthia",
		});
	});

	it("theme wraps the theme in quotes", () => {
		expect(by.get("theme")).toMatchObject({ title: "“A Fresh Start”" });
	});

	it("wordOfDay carries word, definition and example", () => {
		const wod = by.get("wordOfDay");
		expect(wod?.title).toBe("Momentum");
		expect(wod?.body).toEqual([
			"impetus gained by a moving object",
			"“The momentum of the river keeps moving forward.”",
		]);
	});

	it("geIntro lists the functionary team", () => {
		expect(by.get("geIntro")).toMatchObject({ title: "Saiful" });
		expect(by.get("geIntro")?.body).toContain("Grammarian · Mona");
	});

	it("speech carries speaker, title, level and time", () => {
		const speech = slideContent(deck.find((s) => s.kind === "speech") as Slide);
		expect(speech.eyebrow).toBe("Speech 1");
		expect(speech.title).toBe("Rehanna");
		expect(speech.body).toEqual([
			"“A Tasteful Historic Profile”",
			"Level 1 · 5–7 minutes",
		]);
	});

	it("vote slides list nominees under a Cast your vote headline", () => {
		expect(by.get("voteSpeaker")).toMatchObject({
			eyebrow: "Vote for Best Speaker",
			title: "Cast your vote",
			body: ["Rehanna", "Sudheer"],
		});
		expect(by.get("voteTableTopics")).toMatchObject({
			eyebrow: "Vote for Best Table Topics",
			title: "Cast your vote",
			body: [],
		});
		expect(by.get("voteEvaluator")).toMatchObject({
			eyebrow: "Vote for Best Evaluator",
			body: ["Faisal"],
		});
	});

	it("tableTopics + evaluation session carry their people and timing", () => {
		expect(by.get("tableTopics")).toMatchObject({
			eyebrow: "Table Topics",
			title: "Rasheed",
		});
		expect(by.get("evalIntro")).toMatchObject({ title: "Saiful" });
		expect(by.get("evaluation")).toMatchObject({ title: "Faisal" });
		expect(by.get("evaluation")?.body[0]).toContain("Evaluates Rehanna");
		expect(by.get("generalEvaluation")).toMatchObject({ title: "Saiful" });
	});

	it("awards + reminders + thankYou", () => {
		expect(by.get("awards")?.body).toEqual([
			"Best Table Topic",
			"Best Evaluator",
			"Best Speaker",
		]);
		expect(by.get("reminders")?.body).toEqual([
			"Choose a learning path.",
			"Bring a guest.",
		]);
		expect(by.get("thankYou")).toMatchObject({
			title: "Thank you",
			body: ["We meet 2nd & 4th Thursday"],
		});
	});
});

// Read the editable text back out of a built pptxgenjs slide.
function slideText(pptx: PptxGenJS, i: number): string {
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	const objects = (pptx as any).slides[i]._slideObjects as any[];
	return objects
		.filter((o) => o._type === "text")
		.flatMap((o) => (o.text as { text: string }[]).map((t) => t.text))
		.join("\n");
}

describe("deckToPptx", () => {
	it("emits exactly one native slide per deck slide, in order", () => {
		const deck = buildSlideDeck(meeting, club, fullSlots);
		const pptx = deckToPptx(PptxGenJS, deck);
		// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals
		expect((pptx as any).slides).toHaveLength(deck.length);
	});

	it("writes the club name onto the title slide and nominees onto votes", () => {
		const deck = buildSlideDeck(meeting, club, fullSlots);
		const pptx = deckToPptx(PptxGenJS, deck);
		expect(slideText(pptx, 0)).toContain("MCF Toastmasters Club");
		const voteIdx = deck.findIndex((s) => s.kind === "voteSpeaker");
		const voteText = slideText(pptx, voteIdx);
		expect(voteText).toContain("Cast your vote");
		expect(voteText).toContain("Rehanna");
	});

	it("produces a real, non-empty pptx buffer that opens as a zip (pptx)", async () => {
		const deck = buildSlideDeck(meeting, club, []);
		const pptx = deckToPptx(PptxGenJS, deck);
		const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
		expect(buf.length).toBeGreaterThan(0);
		// .pptx is a zip → starts with the "PK" local-file-header magic bytes.
		expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
	});
});

describe("pptxFileName", () => {
	it("derives a meaningful name from club + meeting day in club tz", () => {
		expect(
			pptxFileName(
				"MCF Toastmasters Club",
				new Date("2026-06-25T23:45:00Z"),
				"America/Chicago",
			),
		).toBe("MCF Toastmasters Club - 2026-06-25 Agenda.pptx");
	});

	it("strips filesystem-reserved characters from the club name", () => {
		expect(
			pptxFileName("A/B: Club?", new Date("2026-01-02T12:00:00Z"), "UTC"),
		).toBe("AB Club - 2026-01-02 Agenda.pptx");
	});
});
