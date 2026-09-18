import PptxGenJS from "pptxgenjs";
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
	type Slide,
} from "./agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "./brand";
import { type ClubLogoAsset, deckToPptx, pptxFileName } from "./deck-to-pptx";
import {
	SPLASH_LOGO_HEIGHT_PCT,
	SPLASH_LOGO_MAX_WIDTH_PCT,
} from "./slide-layout";
import {
	inchesOfWidth,
	SLIDE_BODY_BOTTOM_PCT,
	SLIDE_FOOTER_HEIGHT_PCT,
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

describe("club logo on the bookend splashes (#496, #725)", () => {
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

	/** Does this slide carry the nominative word "Toastmasters" on its own?
	 *  A WHOLE line equal to it, not `slideText().toContain`: the club is called
	 *  "MCF Toastmasters Club" and the non-affiliation disclaimer on a content
	 *  footer spells it out too, so a substring check answers yes for most of
	 *  the deck whether or not the word is rendered. */
	function hasWord(pptx: PptxGenJS, i: number): boolean {
		return slideText(pptx, i)
			.split("\n")
			.some((line) => line === "Toastmasters");
	}

	const withLogo: ClubForDeck = { ...club, logoUrl: "/api/club/abc/logo?v=1" };

	/** The deck a club WITH a logo gets. The closing splash is its last slide. */
	function logoDeck() {
		return buildSlideDeck({
			meeting,
			club: withLogo,
			slots: fullSlots,
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
	}

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

	// #725 moved this from ONE slide to exactly TWO. The count is the point: a
	// logo placed on every splash is the outcome the `templateSection` null
	// guards against, and "at least one" would not see it.
	it("puts the logo on both bookend splashes and nowhere else", () => {
		const deck = logoDeck();
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
		// biome-ignore lint/suspicious/noExplicitAny: pptxgenjs internals
		const carrying = ((pptx as any).slides as any[])
			.map((_s, i) => i)
			.filter((i) => slideImages(pptx, i).length > 0);
		expect(deck[deck.length - 1]?.kind).toBe("thankYou");
		expect(carrying).toEqual([0, deck.length - 1]);
	});

	it("embeds the image on the closing splash, which used to carry none (#725)", () => {
		const deck = logoDeck();
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
		expect(slideImages(pptx, deck.length - 1)).toHaveLength(1);
	});

	// The mark REPLACES the word — the pair the issue is about. Asserted on both
	// bookends, because the closing splash reaches `renderSplash` by a different
	// route (deck-level `clubLogoUrl`, not a field on its own slide).
	it("drops the word Toastmasters from a splash that carries the logo", () => {
		const deck = logoDeck();
		const pptx = deckToPptx(PptxGenJS, deck, LOGO);
		expect(hasWord(pptx, 0)).toBe(false);
		expect(hasWord(pptx, deck.length - 1)).toBe(false);
	});

	it("keeps the word on both splashes when the club has no logo", () => {
		const deck = buildSlideDeck({
			meeting,
			club,
			slots: fullSlots,
			ballotUrl: BALLOT_URL,
			geIntroducesFunctionaries: false,
		});
		const pptx = deckToPptx(PptxGenJS, deck, null);
		expect(hasWord(pptx, 0)).toBe(true);
		expect(hasWord(pptx, deck.length - 1)).toBe(true);
	});

	// The amendment on #725. The bytes are fetched in the BROWSER at click time
	// and that fetch can fail; keying the fallback on `logoUrl` rather than on
	// the loaded image would leave the splash carrying neither mark nor word.
	it("falls back to the word when the club has a logo the caller could not fetch", () => {
		const deck = logoDeck();
		const pptx = deckToPptx(PptxGenJS, deck, null);
		expect(slideImages(pptx, 0)).toHaveLength(0);
		expect(slideImages(pptx, deck.length - 1)).toHaveLength(0);
		expect(hasWord(pptx, 0)).toBe(true);
		expect(hasWord(pptx, deck.length - 1)).toBe(true);
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
	function splashImage(logo: ClubLogoAsset, which: "opening" | "closing") {
		const deck = logoDeck();
		const i = which === "opening" ? 0 : deck.length - 1;
		const [img] = slideImages(deckToPptx(PptxGenJS, deck, logo), i);
		return img.options as { x: number; y: number; w: number; h: number };
	}
	const titleImage = (logo: ClubLogoAsset) => splashImage(logo, "opening");

	/**
	 * The box, in inches, stated as LITERALS rather than re-derived from
	 * `SPLASH_LOGO_*_PCT`.
	 *
	 * A bound written as `inchesOfWidth(SPLASH_LOGO_HEIGHT_PCT, 13.33)` holds for
	 * every value those constants could take, including a typo that shrinks the
	 * mark back to a postage stamp — it cannot fail, which is the trap
	 * CLAUDE.md names for a test stated relative to the constant it guards. The
	 * proportions are pinned separately, once, below.
	 */
	const BOX_W_IN = 7.7314; // 58% of 13.33
	const BOX_H_IN = 1.9995; // 15% of 13.33
	/** The box before #725, when the logo sat above the word. */
	const OLD_BOX_H_IN = 0.85;

	it("declares the proportions the projected splash sizes with", () => {
		expect(SPLASH_LOGO_MAX_WIDTH_PCT).toBe(58);
		expect(SPLASH_LOGO_HEIGHT_PCT).toBe(15);
		expect(inchesOfWidth(SPLASH_LOGO_MAX_WIDTH_PCT, 13.33)).toBeCloseTo(
			BOX_W_IN,
			3,
		);
		expect(inchesOfWidth(SPLASH_LOGO_HEIGHT_PCT, 13.33)).toBeCloseTo(
			BOX_H_IN,
			3,
		);
	});

	// "Larger than today" is the whole request, and nothing above can see it: a
	// correctly-contained postage stamp passes every shape assertion here.
	it("gives a square crest more than twice the height the old box allowed", () => {
		const { h } = titleImage({ ...LOGO, width: 512, height: 512 });
		expect(h).toBeGreaterThan(OLD_BOX_H_IN * 2);
	});

	// The logo grew into the space the word vacated, which ends at y=2.25; the
	// rule sits at y=2.5. Everything below it must be exactly where it was, so
	// the plate — not just the image — has to clear the rule.
	it("keeps the logo and its plate clear of the rule under it", () => {
		const deck = logoDeck();
		const pptx = deckToPptx(PptxGenJS, deck, {
			...LOGO,
			width: 512,
			height: 512,
		});
		for (const i of [0, deck.length - 1]) {
			// biome-ignore lint/suspicious/noExplicitAny: pptxgenjs internals
			const objects = (pptx as any).slides[i]._slideObjects as any[];
			const plate = objects.find(
				(o) => o.options?.fill?.color === "FFFFFF" && o.options?.w,
			);
			const [img] = slideImages(pptx, i);
			expect(plate.options.y).toBeGreaterThanOrEqual(0);
			expect(plate.options.y + plate.options.h).toBeLessThan(2.5);
			expect(img.options.y + img.options.h).toBeLessThan(2.5);
		}
	});

	/** `renderSplash`'s plate padding, in inches. Copied, and pinned below. */
	const PLATE_PAD_IN = 0.08;

	// The horizontal half of the same sentence, and the one #725's review caught.
	// `SPLASH_LOGO_MAX_WIDTH_PCT` is documented as "exactly the width of the rule
	// beneath it" — which was true of the projected splash, where both are drawn
	// from the same constant, and FALSE here: the rule was a hard-coded `w: 6` on
	// a 13.33in frame (45%) while the box was 58%, so a max-width wordmark
	// overhung its own rule by ~0.87in a side in the downloaded deck. The
	// vertical assertion above passes throughout; only a width comparison sees
	// it. Measured against the RENDERED rule, not a restated proportion.
	it("keeps the logo and its plate within the rule's width", () => {
		const deck = logoDeck();
		const pptx = deckToPptx(PptxGenJS, deck, {
			...LOGO,
			// 10:1 — the widest shape the ceiling has to hold, and the only one
			// that can reach the rule's edge at all.
			width: 2000,
			height: 200,
		});
		for (const i of [0, deck.length - 1]) {
			// biome-ignore lint/suspicious/noExplicitAny: pptxgenjs internals
			const objects = (pptx as any).slides[i]._slideObjects as any[];
			const line = objects.find((o) => o.options?.line && o.options?.h === 0);
			expect(line, "no rule on the splash").toBeTruthy();
			const ruleLeft = line.options.x as number;
			const ruleRight = ruleLeft + (line.options.w as number);
			expect(line.options.w).toBeGreaterThan(0);

			const plate = objects.find(
				(o) => o.options?.fill?.color === "FFFFFF" && o.options?.w,
			);
			const [img] = slideImages(pptx, i);

			// The MARK is what the ceiling governs, and it must fit outright.
			expect(
				img.options.x,
				"the mark overhangs the rule's left edge",
			).toBeGreaterThanOrEqual(ruleLeft - 0.01);
			expect(
				img.options.x + img.options.w,
				"the mark overhangs the rule's right edge",
			).toBeLessThanOrEqual(ruleRight + 0.01);

			// The plate may exceed it by `renderSplash`'s own `pad` and nothing
			// else — the same bound the projected splash puts on `ClubLogo`'s 4px,
			// so the two surfaces state one rule in their own units rather than
			// one of them quietly allowing more.
			expect(
				ruleLeft - plate.options.x,
				"the plate exceeds the rule by more than its padding",
			).toBeLessThanOrEqual(PLATE_PAD_IN + 0.01);
			expect(
				plate.options.x + plate.options.w - ruleRight,
				"the plate exceeds the rule by more than its padding",
			).toBeLessThanOrEqual(PLATE_PAD_IN + 0.01);
		}
	});

	it("places the closing splash's logo exactly where the opening one sits", () => {
		const square = { ...LOGO, width: 512, height: 512 };
		expect(splashImage(square, "closing")).toEqual(
			splashImage(square, "opening"),
		);
	});

	it("keeps a square crest square instead of stretching it to the box", () => {
		const { w, h } = titleImage({ ...LOGO, width: 512, height: 512 });
		expect(w).toBeCloseTo(h, 5);
	});

	it("fits a wide wordmark to the box without exceeding either dimension", () => {
		const { w, h } = titleImage({ ...LOGO, width: 1200, height: 300 });
		// 4:1 source stays 4:1, and is width-limited inside the box: at
		// `SPLASH_LOGO_MAX_WIDTH_PCT` of the frame the box is now wider than four
		// times its own height.
		expect(w / h).toBeCloseTo(4, 3);
		expect(w).toBeLessThanOrEqual(BOX_W_IN + 1e-6);
		expect(h).toBeLessThanOrEqual(BOX_H_IN + 1e-6);
	});

	// A 10:1 banner is the shape the width bound exists for: contained by height
	// alone it would be 20in wide on a 13.33in slide.
	it("holds an extreme wordmark inside the slide, not just inside the box", () => {
		const { x, w, h } = titleImage({ ...LOGO, width: 3000, height: 300 });
		expect(w).toBeCloseTo(BOX_W_IN, 3);
		expect(w / h).toBeCloseTo(10, 3);
		expect(x).toBeGreaterThan(0);
		expect(x + w).toBeLessThan(13.33);
	});

	it("scales a tall crest to the box height, not its width", () => {
		const { w, h } = titleImage({ ...LOGO, width: 300, height: 1200 });
		expect(h).toBeCloseTo(BOX_H_IN, 3);
		expect(w).toBeCloseTo(BOX_H_IN / 4, 3);
	});

	it("centres the logo horizontally on the slide", () => {
		const { x, w } = titleImage({ ...LOGO, width: 512, height: 512 });
		// 13.33in slide width — equal margins either side.
		expect(x + w / 2).toBeCloseTo(13.33 / 2, 5);
	});

	// AC5 on #725: a contest's round dividers are splashes too, and they keep
	// the word. `slideLayout` decides that, but a renderer that placed the logo
	// on every splash tone would put it back, so it is asserted through the
	// export rather than through the descriptor alone.
	it("leaves a contest's section bands with the word and no logo", () => {
		const contest: Slide[] = [
			{
				kind: "title",
				clubName: "MCF Toastmasters Club",
				logoUrl: "/api/club/abc/logo?v=1",
				district: null,
				clubNumber: null,
				meetingNumber: null,
				scheduledAt: new Date("2026-06-25T23:45:00Z"),
				timezone: "America/Chicago",
			},
			{ kind: "templateSection", title: "Round 1" },
			{
				kind: "thankYou",
				meetingSchedule: "2nd & 4th Thursday",
				nextMeetingAt: null,
				timezone: "America/Chicago",
			},
		];
		const pptx = deckToPptx(PptxGenJS, contest, LOGO);
		expect(slideImages(pptx, 1)).toHaveLength(0);
		expect(hasWord(pptx, 1)).toBe(true);
		// …while the bookends either side of it still carry the mark.
		expect(slideImages(pptx, 0)).toHaveLength(1);
		expect(slideImages(pptx, 2)).toHaveLength(1);
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
const PPTX_FRAME_H = 7.5;

describe("content-slide geometry (#359, #724)", () => {
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
	 * The band itself is full-bleed by design (`x: 0, w: W`), so it is excluded
	 * on geometry rather than by name: a full-width shape has no left edge to
	 * share. Its TEXT is a different matter and is asserted separately below —
	 * until #724 that text carried its own 5% inset against this region's 8%,
	 * which is precisely the thing "one shared left edge" is supposed to mean.
	 * The band's top is found from the slide rather than hardcoded, so tuning
	 * `SLIDE_FOOTER_HEIGHT_PCT` cannot silently pull footer chrome into this set.
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

	/**
	 * The navy band, and the text sitting on it. Found the same way
	 * `contentRegion` finds its complement, so the two partition the slide.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	function footerRegion(objects: any[]) {
		const band = objects.find(
			(o) => o.options?.x === 0 && o.options?.w === PPTX_FRAME_W,
		);
		expect(band, "no full-bleed footer band found").toBeTruthy();
		const footerTop = band.options.y as number;
		const text = objects.filter(
			(o) =>
				o !== band &&
				typeof o.options?.y === "number" &&
				o.options.y >= footerTop,
		);
		return { band, text };
	}

	it("sizes the footer band from the shared proportion (#724)", () => {
		// `FOOT_H` was `1.13` under the comment `// ~8.5% of width` — the HTML
		// deck's `h-[8.5cqw]` copied by hand into inches, and 0.003in out. The
		// 6-place closeness is what makes this an assertion about the DERIVATION:
		// the old literal fails it, a fresh hand copy of 1.133 fails it too.
		const { band } = footerRegion(contentSlide());
		expect(band.options.h).toBeCloseTo(
			inchesOfWidth(SLIDE_FOOTER_HEIGHT_PCT, PPTX_FRAME_W),
			6,
		);
		expect(band.options.y).toBeCloseTo(
			PPTX_FRAME_H - inchesOfWidth(SLIDE_FOOTER_HEIGHT_PCT, PPTX_FRAME_W),
			6,
		);
	});

	it("insets the footer's text to the same edges as the slide above it (#724)", () => {
		// The assertion the pre-#724 geometry failed: the "GavelUp" mark at
		// `x: 0.67` (5.03% of W) against a body at 1.066 (8%), so the one element
		// of the footer that could line up with the rule and the body stood 0.4in
		// inside them. Every footer text box now starts at one inset and ends at
		// the other — left edges and right edges both, since the club/date block
		// is right-aligned and it was its RIGHT edge that carried the old literal.
		const objects = contentSlide();
		const region = contentRegion(objects);
		const { text } = footerRegion(objects);
		const inset = inchesOfWidth(SLIDE_INSET_PCT, PPTX_FRAME_W);
		expect(text.length, "expected mark, club/date and disclaimer").toBe(3);
		// Read through each box's OWN alignment, because a text box's inset is the
		// edge its text is set against: the mark is left-set, the club/date block
		// right-set, the fine print centred across both. Asserting `x` alone would
		// pass a right-aligned block hand-placed to land anywhere.
		for (const o of text) {
			const left = o.options.x as number;
			const right = left + (o.options.w as number);
			const align = o.options.align as string;
			if (align !== "right") {
				expect(left, `${align}-set footer text, left edge`).toBeCloseTo(
					inset,
					6,
				);
			}
			if (align !== "left") {
				expect(right, `${align}-set footer text, right edge`).toBeCloseTo(
					PPTX_FRAME_W - inset,
					6,
				);
			}
		}
		// Every alignment is actually exercised, so the branches above cannot all
		// be vacuously skipped by a footer that lost a block.
		expect(new Set(text.map((o) => o.options.align))).toEqual(
			new Set(["left", "right", "center"]),
		);
		// And it is the same edge the header, rule and body stand on — read off
		// the slide rather than restated, so this cannot agree with a stale
		// constant while disagreeing with the region above it.
		const mark = text.find((o) => o.options.align === "left");
		expect(mark?.options.x).toBeCloseTo(region[0]?.options.x as number, 6);
	});

	it("clears the body off the navy band by the shared bottom inset (#724)", () => {
		// The other half of the report: the body crowded the footer. Measured the
		// way the eye reads it — from the bottom of the body box to the top of the
		// band — so it stays true however `BODY.h`'s arithmetic is rearranged, and
		// stated as a PROPORTION so the on-screen deck's `paddingBottom` and this
		// are the same claim in two units rather than two tunable numbers.
		const objects = contentSlide();
		const region = contentRegion(objects);
		const { band } = footerRegion(objects);
		const body = region.reduce((a, b) => (b.options.y > a.options.y ? b : a));
		const gap =
			(band.options.y as number) -
			((body.options.y as number) + (body.options.h as number));
		expect(gap).toBeCloseTo(
			inchesOfWidth(SLIDE_BODY_BOTTOM_PCT, PPTX_FRAME_W),
			6,
		);
		// And it is real clearance, not the token 1.5% #359 left behind: at least
		// half the gap under the hairline rule above. Same floor the projected
		// deck's own spacing suite asserts.
		expect(gap).toBeGreaterThanOrEqual(
			inchesOfWidth(SLIDE_HEADER_GAP_PCT, PPTX_FRAME_W) / 2,
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
