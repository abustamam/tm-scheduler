import PptxGenJS from "pptxgenjs";
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";
import { deckToPptx, pptxFileName } from "./deck-to-pptx";

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

// Read the editable text back out of a built pptxgenjs slide. `addText` stores
// `.text` as the raw string when called with a plain string, or as an array of
// `{ text }` runs when called with an array — normalize both.
function slideText(pptx: PptxGenJS, i: number): string {
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	const objects = (pptx as any).slides[i]._slideObjects as any[];
	return objects
		.filter((o) => o._type === "text")
		.flatMap((o) =>
			Array.isArray(o.text)
				? (o.text as { text: string }[]).map((t) => t.text)
				: [o.text as string],
		)
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
		expect(voteText).toContain("Vote for Best Speaker");
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

describe("pptx via slideLayout", () => {
	it("builds the whole deck without throwing", () => {
		const deck = buildSlideDeck(
			meeting,
			club,
			fullSlots,
			new Date("2026-07-23T23:45:00Z"),
		);
		const pptx = deckToPptx(PptxGenJS, deck);
		expect(pptx).toBeTruthy();
	});
});
