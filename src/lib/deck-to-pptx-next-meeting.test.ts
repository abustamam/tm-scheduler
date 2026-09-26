import PptxGenJS from "pptxgenjs";
import { describe, expect, it } from "vitest";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";
import { deckToPptx } from "./deck-to-pptx";
import type { NextMeetingSummary } from "./next-meeting-summary";
import { qrRuns } from "./qr-runs";
import { inchesOfWidth, SLIDE_FOOTER_HEIGHT_PCT } from "./slide-spacing";

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-06-25T23:45:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
	tableTopicsNotes: null,
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
const NEXT: NextMeetingSummary = {
	scheduledAt: new Date("2026-07-09T23:45:00Z"),
	location: "Library Room B",
	theme: "Momentum",
	meetingNumber: 57,
	urlKey: "2026-07-09",
	toastmaster: { label: "Toastmaster of the Day", names: [], openCount: 1 },
	roles: [
		{ label: "Timer", names: [], openCount: 1 },
		{ label: "Grammarian", names: ["Mona"], openCount: 0 },
	],
};
const SIGNUP = "https://gavelup.test/club/mcf/meeting/2026-07-09";

const deckWith = (signup: string | null) =>
	buildSlideDeck({
		meeting,
		club,
		slots: [],
		geIntroducesFunctionaries: false,
		ballotUrl: null,
		nextMeeting: NEXT,
		nextMeetingSignupUrl: signup,
	});

type Obj = {
	_type: string;
	text?: string | { text: string; options: Record<string, unknown> }[];
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	options: Record<string, any>;
};

function objectsOf(signup: string | null) {
	const deck = deckWith(signup);
	const i = deck.findIndex((s) => s.kind === "nextMeeting");
	const pptx = deckToPptx(PptxGenJS, deck);
	// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals in test
	const objects = (pptx as any).slides[i]._slideObjects as Obj[];
	return { deck, pptx, objects };
}

const runsOf = (objects: Obj[]) =>
	objects.flatMap((o) =>
		Array.isArray(o.text)
			? o.text
			: typeof o.text === "string"
				? [{ text: o.text, options: {} }]
				: [],
	);

/** The QR's modules: black filled rectangles, which nothing else on a slide is. */
const modules = (objects: Obj[]) =>
	objects.filter((o) => o.options?.fill?.color === "000000");

const W = 13.33;
const H = 7.5;
const FOOT_TOP = H - inchesOfWidth(SLIDE_FOOTER_HEIGHT_PCT, W);

describe("the next-meeting slide in the .pptx (#932)", () => {
	it("is one native slide, in the same place as on screen", () => {
		const { deck, pptx } = objectsOf(SIGNUP);
		// biome-ignore lint/suspicious/noExplicitAny: reads pptxgenjs internals
		expect((pptx as any).slides).toHaveLength(deck.length);
		expect(deck.map((s) => s.kind).slice(-2)).toEqual([
			"nextMeeting",
			"thankYou",
		]);
	});

	it("says what the projected slide says", () => {
		const text = runsOf(objectsOf(SIGNUP).objects)
			.map((r) => r.text)
			.join("");
		for (const s of [
			"What’s on tap for next meeting",
			"Thursday, July 9, 2026 · 6:45 PM · Library Room B",
			"Toastmaster of the Day:",
			"Meeting #57 · Theme: “Momentum”",
			"Timer:",
			"Open: grab it!",
			"Grammarian:",
			" Mona",
			"Scan to grab a role",
		]) {
			expect(text).toContain(s);
		}
	});

	it("colours the open roles in the accent, not the names", () => {
		const runs = runsOf(objectsOf(SIGNUP).objects);
		const open = runs.find((r) => r.text.includes("grab it!"));
		const name = runs.find((r) => r.text === " Mona");
		expect(open?.options.color).toBe("770D29");
		expect(name).toBeDefined();
		expect(name?.options.color).not.toBe("770D29");
	});

	it("draws the SAME absolute URL as a QR, and links it from the caption", () => {
		const { objects } = objectsOf(SIGNUP);
		expect(modules(objects)).toHaveLength(qrRuns(SIGNUP).runs.length);
		const caption = runsOf(objects).find(
			(r) => r.text === "Scan to grab a role",
		);
		expect(caption?.options.hyperlink).toMatchObject({ url: SIGNUP });
	});

	it("keeps the QR inside its white plate and clear of the footer", () => {
		const { objects } = objectsOf(SIGNUP);
		const plate = objects.find((o) => o.options?.fill?.color === "FFFFFF");
		if (!plate) throw new Error("no plate");
		const p = plate.options;
		expect(p.y + p.h).toBeLessThan(FOOT_TOP);
		expect(p.x + p.w).toBeLessThanOrEqual(W);
		for (const m of modules(objects)) {
			const o = m.options;
			expect(o.x).toBeGreaterThanOrEqual(p.x);
			expect(o.y).toBeGreaterThanOrEqual(p.y);
			expect(o.x + o.w).toBeLessThanOrEqual(p.x + p.w + 1e-9);
			expect(o.y + o.h).toBeLessThanOrEqual(p.y + p.h + 1e-9);
		}
	});

	it("has no QR and no link before the origin is known", () => {
		const { objects } = objectsOf(null);
		expect(modules(objects)).toEqual([]);
		const text = runsOf(objects)
			.map((r) => r.text)
			.join("");
		expect(text).not.toContain("Scan to grab a role");
		// …and the roles are all still there.
		expect(text).toContain("Open: grab it!");
	});

	it("writes a real file", async () => {
		const { pptx } = objectsOf(SIGNUP);
		const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
		expect(out.byteLength).toBeGreaterThan(10_000);
	});
});
