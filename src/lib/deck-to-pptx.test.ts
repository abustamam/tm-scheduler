import PptxGenJS from "pptxgenjs";
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "./brand";
import { type ClubLogoAsset, deckToPptx, pptxFileName } from "./deck-to-pptx";
import {
	inchesOfWidth,
	SLIDE_HEADER_GAP_PCT,
	SLIDE_INSET_PCT,
} from "./slide-spacing";

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
	logoUrl: null,
	tableTopicsMinSeconds: null,
	tableTopicsMaxSeconds: null,
};

// This suite exercises pptx export, never ballot content, so one fixture
// value stands in everywhere `buildSlideDeck` requires it (#510).
const BALLOT_URL = "https://gavelup.test/club/mcf/meeting/2026-06-25/vote";

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
			ballotUrl: BALLOT_URL,
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
			ballotUrl: BALLOT_URL,
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
			ballotUrl: BALLOT_URL,
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
			ballotUrl: BALLOT_URL,
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
			ballotUrl: BALLOT_URL,
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
				ballotUrl: BALLOT_URL,
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
			ballotUrl: BALLOT_URL,
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
	// decoded by these assertions — the intrinsic size is carried alongside on
	// `ClubLogoAsset`, because that is how the real caller supplies it.
	const LOGO_DATA_URI =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	/** A square crest — the shape that was being stretched to 4.7:1. */
	const LOGO: ClubLogoAsset = {
		dataUri: LOGO_DATA_URI,
		width: 512,
		height: 512,
	};

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
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
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
			ballotUrl: BALLOT_URL,
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
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
		expect(slideImages(pptx, 0)).toHaveLength(0);
	});

	it("puts the logo ONLY on the title slide, not on every splash", () => {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
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
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
		expect(slideText(pptx, 0)).toContain("MCF Toastmasters Club");
	});

	// The four assertions above all count image OBJECTS, which is structurally
	// blind to how the image is SHAPED — a stretched logo and a correct one are
	// both "one image". The .pptx really did emit `<a:stretch/>` into a
	// 4in x 0.85in frame, smearing a square crest to 4.7:1, while every one of
	// those tests passed. These assert the geometry instead.
	function titleImage(logo: ClubLogoAsset) {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const [img] = slideImages(deckToPptx(PptxGenJS, deck, logo), 0);
		return img.options as { x: number; y: number; w: number; h: number };
	}

	it("keeps a square crest square instead of stretching it to the box", () => {
		const { w, h } = titleImage({ ...LOGO, width: 512, height: 512 });
		expect(w).toBeCloseTo(h, 5);
	});

	it("fits a wide wordmark to the box without exceeding either dimension", () => {
		const { w, h } = titleImage({ ...LOGO, width: 1200, height: 300 });
		// 4:1 source stays 4:1, and is height-limited inside the 4 x 0.85 box.
		expect(w / h).toBeCloseTo(4, 3);
		expect(w).toBeLessThanOrEqual(4 + 1e-6);
		expect(h).toBeLessThanOrEqual(0.85 + 1e-6);
	});

	it("scales a tall crest to the box height, not its width", () => {
		const { w, h } = titleImage({ ...LOGO, width: 300, height: 1200 });
		expect(h).toBeCloseTo(0.85, 5);
		expect(w).toBeCloseTo(0.2125, 4);
	});

	it("centres the logo horizontally on the slide", () => {
		const { x, w } = titleImage({ ...LOGO, width: 512, height: 512 });
		// 13.33in slide width — equal margins either side.
		expect(x + w / 2).toBeCloseTo(13.33 / 2, 5);
	});

	it("puts a light plate behind the logo so a dark one stays visible", () => {
		const deck = buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
		// biome-ignore lint/suspicious/noExplicitAny: pptxgenjs internals
		const objects = (pptx as any).slides[0]._slideObjects as any[];
		const plate = objects.find(
			(o) => o.options?.fill?.color === "FFFFFF" && o.options?.w,
		);
		expect(plate).toBeTruthy();
		const [img] = slideImages(pptx, 0);
		// The plate must fully contain the image, or it is not backing anything.
		expect(plate.options.x).toBeLessThan(img.options.x);
		expect(plate.options.y).toBeLessThan(img.options.y);
		expect(plate.options.x + plate.options.w).toBeGreaterThan(
			img.options.x + img.options.w,
		);
		expect(plate.options.y + plate.options.h).toBeGreaterThan(
			img.options.y + img.options.h,
		);
	});
});

/**
 * Content-slide spacing agrees with the projected deck (#359).
 *
 * The two renderers size in different units — `cqw` on screen, inches here — so
 * nothing but a shared PROPORTION can keep them together, and before #359
 * nothing did: each file independently carried a 6% header inset and a 7-7.5%
 * body inset. The body sat indented past the maroon rule that heads it, on both
 * surfaces, and it never read as a bug because the two surfaces agreed with each
 * other while both disagreed internally.
 *
 * So these assert the RELATIONSHIP, not the numbers. A test pinning `x` to
 * 1.0664 would have to be edited every time the inset is tuned, which trains
 * people to edit the test instead of reading it; a test saying "the header, the
 * rule and the body share one left edge" fails only when the thing that matters
 * breaks.
 */
/** The 16:9 frame `deck-to-pptx` builds on. Private there, so named here — a
 *  wrong value makes the derivation assertion fail loudly rather than pass. */
const PPTX_FRAME_W = 13.33;

describe("content-slide geometry (#359)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	const objectsOn = (pptx: PptxGenJS, i: number): any[] =>
		// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
		((pptx as any).slides[i]._slideObjects as any[]) ?? [];

	/** A content slide: header text, the maroon rule, and a body. */
	function contentSlide() {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck);
		// The Word-of-the-Day slide: a content slide present under both configs.
		const idx = deck.findIndex((s) => s.kind === "wordOfDay");
		expect(idx, "no wordOfDay slide in the fixture deck").toBeGreaterThan(-1);
		return objectsOn(pptx, idx);
	}

	/**
	 * Everything ABOVE the footer band — the header, the rule and the body.
	 *
	 * The footer is full-bleed by design (`x: 0, w: W`) and carries its own
	 * inset for the club name and date, so including it would make any
	 * shared-edge assertion meaningless. Its top is found from the slide rather
	 * than hardcoded, so tuning `FOOT_H` cannot silently pull footer chrome into
	 * this set.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	function contentRegion(objects: any[]) {
		const band = objects.find(
			(o) => o.options?.x === 0 && o.options?.w === PPTX_FRAME_W,
		);
		expect(band, "no full-bleed footer band found").toBeTruthy();
		const footerTop = band.options.y as number;
		return objects.filter(
			(o) =>
				typeof o.options?.x === "number" &&
				typeof o.options?.y === "number" &&
				o.options.y < footerTop,
		);
	}

	it("gives the header, the rule and the body one shared left edge", () => {
		const region = contentRegion(contentSlide());
		// Header text, maroon rule, body — three elements, one edge.
		expect(region.length).toBe(3);
		const lefts = region.map((o) => (o.options.x as number).toFixed(4));
		// The assertion the pre-#359 geometry failed: header and rule at 0.8, body
		// at 1.0, so the body was indented past the rule that heads it.
		expect(new Set(lefts).size).toBe(1);
	});

	it("derives that edge from the shared proportion, not a literal", () => {
		const region = contentRegion(contentSlide());
		expect(region[0]?.options.x).toBeCloseTo(
			inchesOfWidth(SLIDE_INSET_PCT, PPTX_FRAME_W),
			6,
		);
	});

	it("separates the rule from the body by the shared gap", () => {
		const region = contentRegion(contentSlide());
		const ys = region.map((o) => o.options.y as number).sort((a, b) => a - b);
		const [, ruleY, bodyY] = ys;
		// The rule's own height is part of the geometry, so this reads the gap the
		// way the eye does: from the bottom of the rule to the top of the body.
		const rule = region.find((o) => o.options.y === ruleY);
		const gap = (bodyY ?? 0) - ((ruleY ?? 0) + (rule?.options.h ?? 0));
		expect(gap).toBeCloseTo(
			inchesOfWidth(SLIDE_HEADER_GAP_PCT, PPTX_FRAME_W),
			6,
		);
	});

	it("leaves the body a positive height inside the footer", () => {
		// `BODY.h` is now arithmetic over the shared values rather than a literal,
		// so this is the guard against a token change quietly producing a
		// negative-height text box that pptxgenjs would happily accept.
		const objects = contentSlide();
		for (const o of objects) {
			if (typeof o.options?.h === "number") {
				expect(
					o.options.h,
					`${o._type} has non-positive height`,
				).toBeGreaterThan(0);
			}
		}
	});
});
