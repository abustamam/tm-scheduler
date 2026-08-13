/**
 * How LEGIBLE the one-page agenda prints — the thing the page count cannot see.
 *
 * `FitPage` scales a surface down until it fits its sheet, so on the one-page
 * layouts the printed type size is not what the components declare: it is that
 * size times `PAGE_H / naturalHeight`. Editorial declares 10.5px body text and
 * printed it at roughly 6.4pt, because a real club agenda measured ~1299px into
 * a 1056px page. Nothing in this repo could see that. `print-page-count.test.tsx`
 * reports 1 sheet whether the page is comfortable or crushed — a `.agenda-page`
 * is `overflow: hidden`, so content volume provably cannot move that number —
 * jsdom performs no layout at all, and typecheck and lint have no view of
 * geometry. So a change could make the club's agenda 20 percent less readable
 * with every gate green, which is the shape this file exists to catch.
 *
 * The gate is stated in PRINTED POINTS against an absolute literal, not as a
 * ceiling on the sheet's height. A height ceiling looks equivalent and is not:
 * it passes for any declared type size at all, so a layout that got shorter by
 * shrinking its own text — the exact regression — would clear it. Points make
 * the declared constant and the measured height both load-bearing in one number,
 * and say the thing in the unit the original complaint was made in.
 *
 * That still leaves a gap, verified by mutation rather than assumed: reverting
 * `detail` from 11.5 to 10.5 clears the floor anyway, because a smaller declared
 * size makes a shorter sheet that `FitPage` then scales less. So the floor gates
 * the OUTCOME and a second assertion pins the CONSTANT. Neither is redundant.
 *
 * The fixture is one REAL agenda — MCF's 2026-08-13 meeting, transcribed from
 * the deployed page — rather than a generated one. A synthetic fixture would
 * have to guess how often a club runs the same presenter through consecutive
 * beats, and that frequency is the entire subject: the real sheet has a
 * four-beat General Evaluator run and a three-beat President close.
 *
 * Two things these numbers are NOT. They are not comparable to a figure measured
 * against the deployed site: the harness runs with `MAP * ~NOTFOUND`, so
 * Fraunces and Manrope never load and whatever the platform substitutes has its
 * own metrics — which is also why the floors carry a wide margin (see
 * `agenda-print-type.ts`), since the substitute differs between a developer's
 * macOS and CI's Ubuntu and moves where lines wrap. And a passing floor is not a
 * promise about a bigger club — see the dense-agenda case at the bottom, which
 * is the axis a single fixture would miss.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	EDITORIAL_DENSE_MIN_PRINTED_PT,
	EDITORIAL_MIN_PRINTED_PT,
	pxToPt,
	RUN_NARRATIVE_TYPE,
} from "#/lib/agenda-print-type";
import type { TimelineRow } from "#/lib/agenda-timing";
import {
	findChrome,
	measuredHeight,
	printableDocument,
} from "#/test/print-page-count";
import {
	type AgendaHeader,
	type AgendaLayout,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";
import { PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

const header: AgendaHeader = {
	clubName: "MCF Toastmasters",
	logoUrl: null,
	clubNumber: "1234567",
	district: "District 39",
	mission:
		"At Muslim Community of Folsom, (MCF) Toastmasters, our mission is to " +
		"build a thriving community that fosters self-development and leadership. " +
		"Through dynamic learning experiences, we empower individuals to inspire " +
		"positive change within our club, local community, and beyond.",
	meetingSchedule: "2nd & 4th Thursdays, 6:45-7:45",
	dateLong: "Thursday, August 13, 2026",
	dateShort: "Thu · Aug 13, 2026",
	timeRange: "6:45 – 7:45 PM",
	theme: "Growth",
	wordOfTheDay: "Ebullient",
	location: "MCF Conference Room",
	announcements: "Dues are due!",
	meetingNumber: null,
};

const officers = [
	{ office: "President", name: "Schinthia Islam" },
	{ office: "VP Education", name: "Rasheed Bustamam" },
	{ office: "VP Membership", name: "Faisal Ali" },
	{ office: "VP Public Relations", name: "Open" },
	{ office: "Secretary", name: "Sudheer Isanaka" },
	{ office: "Treasurer", name: "Jagpal Singh" },
	{ office: "Sergeant at Arms", name: "Muhammad Ali" },
];

const roles = [
	{ label: "Toastmaster of the Day", name: "Muhammad Ali" },
	{ label: "General Evaluator", name: "Faisal Ali" },
	{ label: "Table Topics Master", name: "Rasheed Bustamam" },
	{ label: "Speaker 1", name: "Jagpal Singh" },
	{ label: "Evaluator 1", name: "Rasheed Bustamam" },
	{ label: "Speaker 2", name: "Sudheer Isanaka" },
	{ label: "Evaluator 3", name: "Riyaz Mohammed" },
	{ label: "Timer", name: "Riyaz Mohammed" },
	{ label: "Ah-Counter", name: "Mahbuba Khan" },
	{ label: "Grammarian", name: "Diego Nuci" },
	{ label: "Vote Counter", name: "Rasheed Bustamam" },
];

const TM = "Toastmaster of the Day · Muhammad Ali";
const GE = "General Evaluator · Faisal Ali";
const TTM = "Table Topics Master · Rasheed Bustamam";

function handoff(who: string, roleKey: string, detail: string, time: string) {
	return { who, roleKey, detail, minutes: 0, marks: null, handoff: true, time };
}

/** MCF's 2026-08-13 run of show: 20 timed beats and 8 hand-offs, in page order. */
const mcfRows: TimelineRow[] = [
	{
		who: "Sergeant-at-Arms",
		detail: "Call to Order · phones silent · introduces the President",
		minutes: 1,
		marks: null,
		time: "6:45",
	},
	{
		who: "President",
		detail: "Opening remarks; welcomes guests",
		minutes: 1,
		marks: null,
		time: "6:46",
	},
	{
		who: TM,
		roleKey: "toastmaster_of_the_day",
		detail: "Opens meeting · introduces the theme",
		minutes: 3,
		marks: null,
		time: "6:47",
	},
	handoff(
		TM,
		"toastmaster_of_the_day",
		"Introduces the General Evaluator",
		"6:50",
	),
	{
		who: GE,
		roleKey: "general_evaluator",
		detail:
			"Introduces the Timer, Ah-Counter, Grammarian & Vote Counter; each " +
			"explains their role · the Grammarian gives the Word of the Day",
		minutes: 3,
		marks: null,
		time: "6:50",
	},
	handoff(TM, "toastmaster_of_the_day", "Introduces the speakers", "6:53"),
	{
		who: "Speaker 1 · Jagpal Singh",
		roleKey: "speaker",
		detail: '"Corporate IT Leadership - Reshaped by AI" · Level 4',
		minutes: 7,
		marks: { green: 5, yellow: 6, red: 7 },
		time: "6:53",
	},
	{
		who: "Speaker 2 · Sudheer Isanaka",
		roleKey: "speaker",
		detail: '"AI & Us - The human side of Artificial intelligence" · Level 5',
		minutes: 20,
		marks: { green: 15, yellow: 17.5, red: 20 },
		time: "7:00",
	},
	{
		who: TM,
		roleKey: "toastmaster_of_the_day",
		detail: "Calls for the Timer's report · opens voting for Best Speaker",
		minutes: 1,
		marks: null,
		time: "7:20",
	},
	handoff(
		TM,
		"toastmaster_of_the_day",
		"Introduces the Table Topics Master",
		"7:21",
	),
	{
		who: TTM,
		roleKey: "table_topics_master",
		detail:
			"Impromptu topics using the Word of the Day · asks the Timer to " +
			"explain the timing",
		minutes: 5,
		marks: { green: 1, yellow: 1.5, red: 2 },
		flex: true,
		time: "7:21",
	},
	{
		who: TTM,
		roleKey: "table_topics_master",
		detail: "Calls for the Timer's report · opens voting for Best Table Topics",
		minutes: 1,
		marks: null,
		time: "7:26",
	},
	handoff(
		TTM,
		"table_topics_master",
		"Introduces the General Evaluator",
		"7:27",
	),
	handoff(GE, "general_evaluator", "Introduces the speech evaluators", "7:27"),
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Asks the Timer to explain the timing for an evaluation",
		minutes: 1,
		marks: null,
		time: "7:27",
	},
	{
		who: "Evaluator 1 · Rasheed Bustamam",
		roleKey: "evaluator",
		detail: "Evaluates Jagpal Singh",
		minutes: 3,
		marks: { green: 2, yellow: 2.5, red: 3 },
		time: "7:28",
	},
	{
		who: "Evaluator 2 · Riyaz Mohammed",
		roleKey: "evaluator",
		detail: "Evaluates Sudheer Isanaka",
		minutes: 3,
		marks: { green: 2, yellow: 2.5, red: 3 },
		time: "7:31",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Calls for the Timer's report · opens voting for Best Evaluator",
		minutes: 1,
		marks: null,
		time: "7:34",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Evaluates the evaluators",
		minutes: 2,
		marks: null,
		time: "7:35",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Calls for the functionary reports",
		minutes: 3,
		marks: null,
		time: "7:37",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Overall meeting evaluation · returns control to the Toastmaster",
		minutes: 2,
		marks: null,
		time: "7:40",
	},
	{
		who: TM,
		roleKey: "toastmaster_of_the_day",
		detail:
			"Awards · Best Table Topic, Best Evaluator & Best Speaker · hands " +
			"over to the President",
		minutes: 2,
		marks: null,
		time: "7:42",
	},
	{
		who: "President",
		detail: "Club business · announcements",
		minutes: 2,
		marks: null,
		time: "7:44",
	},
	{
		who: "President",
		detail: "Guest Comments · invites our guests to share their thoughts",
		minutes: 2,
		marks: null,
		time: "7:46",
	},
	{
		who: "President",
		detail: "Adjourns",
		minutes: 1,
		marks: null,
		time: "7:48",
	},
];

function agendaHeight(layout: AgendaLayout, rows: TimelineRow[]): number {
	const html = renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={header}
			roles={roles}
			officers={officers}
			explainers={[]}
			rows={rows}
		/>,
	);
	return measuredHeight(
		printableDocument(PRINT_PAGE_CSS, html),
		// The first sheet. `TwoPage` layouts emit two, and on those the run of show
		// is the SECOND — measuring `[data-fit-inner]` unqualified would silently
		// average nothing and report the cover page's height.
		"[data-fit-inner]",
	);
}

const hasChrome = findChrome() !== null;

describe("print density harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every density measurement would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

/**
 * What the club's printer actually puts on paper, in points.
 *
 * This, not the height, is the gate. A ceiling on height is the obvious thing to
 * write and it cannot hold the property: it passes for ANY declared type size,
 * so putting `detail` back to 10.5 — undoing half this change — would satisfy it
 * comfortably. Multiplying the declared size by the scale `FitPage` will apply
 * makes both the constant and the layout load-bearing in one number, and states
 * it in the unit the complaint was made in ("this agenda is quite small").
 */
function printedDetailPt(rows: TimelineRow[]): number {
	const scale = (PAGE_H - 2) / agendaHeight("editorial", rows);
	return pxToPt(RUN_NARRATIVE_TYPE.sm.detail * scale);
}

describe.skipIf(!hasChrome)("editorial agenda density", () => {
	it("prints a real club agenda's body text large enough to read", () => {
		// Measured 6.88pt on macOS harness fonts, against 5.59pt before this
		// change: 1484px → 1321px of content on a 1056px sheet, plus declared
		// 10.5 → 11.5. The floor sits well below both for the wrapping reason
		// `agenda-print-type.ts` explains.
		expect(printedDetailPt(mcfRows)).toBeGreaterThanOrEqual(
			EDITORIAL_MIN_PRINTED_PT,
		);
	});

	it("keeps the measured type bump — the floor above cannot see it", () => {
		// Verified by mutation: putting `detail` back to 10.5 still clears
		// EDITORIAL_MIN_PRINTED_PT, because a smaller declared size makes a shorter
		// sheet and `FitPage` gives most of it straight back. The floor gates the
		// outcome; this gates the constant, against a literal rather than against
		// itself — `expect(detail).toBeGreaterThanOrEqual(RUN_NARRATIVE_TYPE.sm.detail)`
		// would pass for every value it could ever hold.
		expect(RUN_NARRATIVE_TYPE.sm.detail).toBeGreaterThanOrEqual(11.5);
		expect(RUN_NARRATIVE_TYPE.sm.name).toBeGreaterThanOrEqual(12.5);
	});

	it("measures a page taller than the sheet — so the floor is not vacuous", () => {
		// `FitPage` only ever shrinks, so a measurement of 0 (a lost `data-fit-inner`
		// hook, a component that started returning null) would compute an enormous
		// scale and sail past the floor above as the most legible agenda ever
		// printed. Same reasoning as the empty-document control that sits beside the
		// page counts: a good-looking number is not proof of content.
		expect(agendaHeight("editorial", mcfRows)).toBeGreaterThan(PAGE_H / 2);
	});

	// The axis a single fixture cannot see. Consolidation only pays where one
	// presenter holds the floor for consecutive beats; a club with more speakers
	// adds beats that alternate every time, and gets none of it back. Bounded
	// separately rather than assumed to follow from the case above.
	it("keeps a denser agenda readable too, at a lower floor", () => {
		const denser: TimelineRow[] = [
			...mcfRows,
			{
				who: "Speaker 3 · Anotherlongname Here",
				roleKey: "speaker",
				detail:
					'"A third prepared speech with a reasonably long title" · Level 2',
				minutes: 7,
				marks: { green: 5, yellow: 6, red: 7 },
				time: "7:08",
			},
			{
				who: "Evaluator 3 · Riyaz Mohammed",
				roleKey: "evaluator",
				detail: "Evaluates Anotherlongname Here",
				minutes: 3,
				marks: { green: 2, yellow: 2.5, red: 3 },
				time: "7:33",
			},
		];
		// Measured 6.42pt, against 5.26pt before this change (1579px of content,
		// declared 10.5). The GAIN holds for a bigger club; the absolute size does
		// not, which is exactly what a separate floor is for.
		expect(printedDetailPt(denser)).toBeGreaterThanOrEqual(
			EDITORIAL_DENSE_MIN_PRINTED_PT,
		);
	});
});
