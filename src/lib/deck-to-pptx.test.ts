import PptxGenJS from "pptxgenjs";
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "./brand";
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
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck);
		// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals
		expect((pptx as any).slides).toHaveLength(deck.length);
	});

	it("writes the club name onto the title slide and nominees onto votes", () => {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck);
		expect(slideText(pptx, 0)).toContain("MCF Toastmasters Club");
		const voteIdx = deck.findIndex((s) => s.kind === "voteSpeaker");
		const voteText = slideText(pptx, voteIdx);
		expect(voteText).toContain("Vote for Best Speaker");
		expect(voteText).toContain("Rehanna");
	});

	it("stamps the Toastmasters non-affiliation disclaimer on content-slide footers", () => {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck);
		const allText = deck.map((_, i) => slideText(pptx, i)).join("\n");
		expect(allText).toContain(TOASTMASTERS_DISCLAIMER);
	});

	it("produces a real, non-empty pptx buffer that opens as a zip (pptx)", async () => {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: [],
			geIntroducesFunctionaries: false,
		});
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
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			nextMeetingAt: new Date("2026-07-23T23:45:00Z"),
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck);
		expect(pptx).toBeTruthy();
	});

	// Both new/renamed slide kinds (#367) go through the shared descriptor, so
	// the .pptx exporter needs no per-kind branch — but it does need to keep
	// producing readable text for them under both club configs.
	it("exports the functionary intro + reports slides under either config", () => {
		for (const geIntroducesFunctionaries of [false, true]) {
			const deck = buildSlideDeck({
				meeting,
				club,
				slots: fullSlots,
				geIntroducesFunctionaries,
			});
			const pptx = deckToPptx(PptxGenJS, deck);
			const introIdx = deck.findIndex((s) => s.kind === "functionaryIntro");
			const reportsIdx = deck.findIndex((s) => s.kind === "functionaryReports");
			expect(introIdx).toBeGreaterThan(-1);
			expect(reportsIdx).toBeGreaterThan(-1);
			expect(slideText(pptx, introIdx)).toContain(
				geIntroducesFunctionaries
					? "General Evaluator:"
					: "Toastmaster of the Day:",
			);
			expect(slideText(pptx, introIdx)).toContain("Grammarian: Mona");
			expect(slideText(pptx, reportsIdx)).toContain("Functionary Reports");
			expect(slideText(pptx, reportsIdx)).toContain("Grammarian: Mona");
		}
	});

	it("exports the Word of the Day onto the Table Topics slide (#355)", () => {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck);
		const idx = deck.findIndex((s) => s.kind === "tableTopics");
		expect(idx).toBeGreaterThan(-1);
		const text = slideText(pptx, idx);
		expect(text).toContain("Word of the Day: “Momentum”");
		expect(text).toContain("impetus gained by a moving object");
	});
});

describe("club logo on the title splash (#496)", () => {
	// A 1x1 transparent PNG. Only its shape matters here; the bytes are never
	// decoded by these assertions.
	const LOGO_DATA_URI =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	/** Image objects pptxgenjs recorded on a built slide. */
	function slideImages(pptx: PptxGenJS, i: number) {
		// biome-ignore lint/suspicious/noExplicitAny: reaching into pptxgenjs internals, same as slideText above
		const objects = (pptx as any).slides[i]._slideObjects as any[];
		return objects.filter((o) => o.image);
	}

	const withLogo: ClubForDeck = { ...club, logoUrl: "/api/club/abc/logo?v=1" };

	it("embeds the image on the title slide when bytes are supplied", () => {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO_DATA_URI);
		expect(slideImages(pptx, 0)).toHaveLength(1);
	});

	// The whole reason the bytes are a separate argument: this runs in the
	// browser and cannot read the database, so a caller that fails to fetch
	// them must still get a working deck.
	it("omits the image when the club has a logo but the bytes could not be fetched", () => {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, null);
		expect(slideImages(pptx, 0)).toHaveLength(0);
	});

	it("omits the image when the club has no logo, even if bytes are passed", () => {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO_DATA_URI);
		expect(slideImages(pptx, 0)).toHaveLength(0);
	});

	it("puts the logo ONLY on the title slide, not on every splash", () => {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO_DATA_URI);
		// biome-ignore lint/suspicious/noExplicitAny: pptxgenjs internals
		const total = ((pptx as any).slides as any[]).reduce(
			(n, _s, i) => n + slideImages(pptx, i).length,
			0,
		);
		expect(total).toBe(1);
	});

	it("keeps the club name on the title slide alongside the logo", () => {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO_DATA_URI);
		expect(slideText(pptx, 0)).toContain("MCF Toastmasters Club");
	});
});
