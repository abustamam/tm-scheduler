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
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import type { TimelineRow } from "#/lib/agenda-timing";
import { buildTimeline } from "#/lib/agenda-timing";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import {
	findChrome,
	measuredHeight,
	printableDocument,
} from "#/test/print-page-count";
import { type AgendaHeader, MeetingAgendaPrint } from "./meeting-agenda-print";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

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
		"Introduces the General Evaluator: Faisal Abdul-Rahman Al-Mansoori",
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
		"Introduces the Table Topics Master: Rasheed Bustamam-Wickramasinghe",
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
		"Introduces the General Evaluator: Faisal Abdul-Rahman Al-Mansoori",
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
		detail:
			"Calls for the Timer, Ah-Counter, Grammarian & Vote Counter to report",
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

/**
 * The natural height of the editorial sheet for `rows`.
 *
 * Hardcodes the layout rather than taking it as a parameter, which is not
 * incidental: `[data-fit-inner]` matches the FIRST sheet, and the two-page
 * layouts (spacious, timing) put the run of show on the SECOND. A `layout`
 * parameter here would let a future caller measure a cover page and get a
 * confident, wrong, much smaller number — the exact silently-plausible failure
 * this file exists to catch. Measuring those layouts needs an nth-sheet
 * selector, so make that change deliberately rather than by passing an argument.
 */
function agendaHeight(rows: TimelineRow[]): number {
	const html = renderToStaticMarkup(
		<MeetingAgendaPrint
			layout="editorial"
			header={header}
			roles={roles}
			officers={officers}
			explainers={[]}
			rows={rows}
		/>,
	);
	return measuredHeight(
		printableDocument(PRINT_PAGE_CSS, html),
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
 * `MIN_FIT_SCALE` is the threshold below which a sheet stops being squeezed and
 * flows across pages instead. Every OTHER assertion in this file is stated in
 * terms of it — `printedDetailPt` mirrors the same `raw < MIN_FIT_SCALE` branch
 * — so raising the constant does not fail any of them. Worse, it fails in the
 * *comfortable* direction: at 0.95 an ordinary agenda would stop scaling, print
 * at full declared size, and the density FLOORS would get more slack, so the
 * suite would go greener while every club's one-page agenda quietly became two.
 * That is CLAUDE.md's "a test stated RELATIVE to the constant it guards cannot
 * fail" trap exactly, so pin the number ABSOLUTELY and pin the property that
 * picked it: it must sit BELOW the tightest scale a real standard agenda needs.
 *
 * No Chrome required — this measures nothing, it constrains the constant.
 */
describe("MIN_FIT_SCALE", () => {
	it("is 0.72", () => {
		expect(MIN_FIT_SCALE).toBe(0.72);
	});

	it("sits below the tightest scale a real standard agenda needs, so ordinary agendas still fit one sheet", () => {
		// The longest standard fixture in this file. `FitPage` flows instead of
		// scaling when `raw < MIN_FIT_SCALE`, so the constant must stay under the
		// ratio this agenda produces or a normal club meeting becomes two sheets.
		const raw = (PAGE_H - 2) / agendaHeight(mcfRows);
		expect(raw).toBeGreaterThan(MIN_FIT_SCALE);
		// And an absolute upper bound, so the assertion above cannot be satisfied
		// by a future fixture that happens to get shorter.
		expect(MIN_FIT_SCALE).toBeLessThan(0.75);
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
	// Clamped at 1 because `FitPage` only ever SHRINKS — its effect is guarded by
	// `if (h > PAGE_H)`, so a sheet that already fits is printed at its declared
	// size with no transform at all. Without the clamp, a layout that got short
	// enough to stop needing a scale would report type LARGER than it prints, and
	// because this is a floor, that overstatement passes. A false pass in the one
	// gate whose whole job is catching false passes.
	const raw = (PAGE_H - 2) / agendaHeight(rows);
	// Mirrors `FitPage`: below MIN_FIT_SCALE it stops scaling and lets the sheet
	// FLOW across pages instead, so the type prints at its declared size. Without
	// this branch the helper would report the crushed size for an agenda that is
	// no longer crushed — and, being a floor, that understatement FAILS rather
	// than passing, which is the safe direction but still wrong.
	const scale = raw < MIN_FIT_SCALE ? 1 : Math.min(1, raw);
	return pxToPt(RUN_NARRATIVE_TYPE.sm.detail * scale);
}

describe.skipIf(!hasChrome)("editorial agenda density", () => {
	it("prints a real club agenda's body text large enough to read", () => {
		// Measured 6.88pt on macOS harness fonts, against 5.59pt before this
		// change: 1484px → 1321px of content on a 1056px sheet, plus declared
		// 10.5 → 11.5. The floor sits well below both for the wrapping reason
		// `agenda-print-type.ts` explains.
		//
		// #584 + #585 spent some of that, measured on Linux harness fonts:
		//
		//   origin/main .................................... 6.799pt
		//   every hand-off named its people ................ 6.470pt
		//   only the SINGULAR hand-offs name them .......... 6.597pt   ← ships
		//
		// The middle row is why the two GROUP hand-offs name nobody. "Introduces
		// the speakers: Alice & Bob" is followed immediately by "Speaker 1 · Alice"
		// and "Speaker 2 · Bob", so it restated the line beneath it — while
		// carrying the longest lists on the sheet, and `FitPage` scales the whole
		// page to fit the longest thing on it. Dropping those two recovered 0.127pt
		// of type across every word of the agenda; the 0.202pt still spent buys the
		// three singular introductions and the reports row naming its functionaries.
		//
		// The fixture carries LONG member names deliberately. #585 made these rows'
		// length a function of member names, which are unbounded user data, so a
		// fixture using this club's real (short) ones measures the easy case —
		// CLAUDE.md's "a fixture that spans ONE axis is not a guarantee", applied to
		// the axis this very change introduced. #584 added a second such axis (the
		// reports row grows with the club's functionary count), so that row names
		// four here rather than three.
		//
		// The 0.40pt left above the 6.2 floor is NOT headroom for the next copy
		// change. `agenda-print-type.ts` says what that margin is for: the harness
		// resolves no webfonts, and the substitute differs between a developer's
		// machine and CI's Ubuntu, moving where lines wrap. It is reserved for that
		// variance. Anything lengthening these rows again needs a fresh measurement
		// here and a compensating reduction, not a lower floor.
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

	it("refuses to measure a selector that matches nothing", () => {
		// The guard every number in this file rests on. `measuredHeight` reads its
		// result back out of `document.title`, so a selector that matched nothing
		// could just as easily have returned 0 or the untouched title — and a 0
		// computes an enormous `FitPage` scale that sails past every floor above.
		// Renaming `data-fit-inner` has to fail loudly, not read as perfect
		// legibility, so this pins the throw rather than trusting the shape.
		const html = renderToStaticMarkup(
			<MeetingAgendaPrint
				layout="editorial"
				header={header}
				roles={roles}
				officers={officers}
				explainers={[]}
				rows={mcfRows}
			/>,
		);
		expect(() =>
			measuredHeight(
				printableDocument(PRINT_PAGE_CSS, html),
				"[data-no-such-hook]",
			),
		).toThrow(/MISSING/);
	});

	it("measures a page taller than the sheet — so the floor is not vacuous", () => {
		// `FitPage` only ever shrinks, so a measurement of 0 (a lost `data-fit-inner`
		// hook, a component that started returning null) would compute an enormous
		// scale and sail past the floor above as the most legible agenda ever
		// printed. Same reasoning as the empty-document control that sits beside the
		// page counts: a good-looking number is not proof of content.
		expect(agendaHeight(mcfRows)).toBeGreaterThan(PAGE_H / 2);
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

/**
 * A CONTEST agenda's printed density (#agenda-templates).
 *
 * This — not a page count — is the gate for a templated agenda, for the reason
 * this whole file exists: `EditorialLayout` wraps its sheet in `FitPage`, which
 * SCALES to fit, so a contest prints one page whether it is comfortable or
 * crushed to 4pt. `printedPageCount` therefore reports 1 for every contestant
 * count and cannot fail. Height, run through the same scale, is the only
 * observable that moves.
 *
 * A contest is the longest agenda this app produces — roughly 40 rows at four
 * contestants and 58 at seven — so it is the worst case for `FitPage`, and the
 * fixture spans the axis that actually varies it: the number of contestants.
 */
describe.skipIf(!hasChrome)("contest agenda density", () => {
	const roleRows = CONTEST_TEMPLATE.roles.map((r) => ({
		key: r.key,
		name: r.name,
		isSpeakerRole: r.isSpeakerRole,
	}));

	/** Slots as `generateSlotRows` would create them, with LONG member names —
	 *  names are unbounded user data and they set the wrap points that decide the
	 *  sheet's height. A fixture using short names measures the easy case. */
	function contestRows(contestants: number): TimelineRow[] {
		const slots = CONTEST_TEMPLATE.roles.flatMap((r) => {
			const n = r.key.startsWith("contestant_") ? contestants : r.defaultCount;
			return Array.from({ length: n }, (_, i) => ({
				id: `${r.key}-${i}`,
				roleName: r.name,
				roleKey: r.key,
				category: r.category,
				isSpeakerRole: r.isSpeakerRole,
				slotIndex: i,
				assigneeName: `Anneliese Vandermeer-Castellanos ${i + 1}`,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			}));
		});
		return buildTimeline(
			resolveAgendaRows({
				geIntroducesFunctionaries: false,
				template: { beats: CONTEST_TEMPLATE.beats, roles: roleRows },
				slots,
			}),
			new Date("2026-09-12T13:00:00Z"),
			"America/Chicago",
		);
	}

	it.each([
		4, 6, 7,
	])("prints body text a member can read with %i contestants", (contestants) => {
		// The DENSE floor, not the standard one: a contest is a deliberately
		// long sheet and is allowed to run tighter than a normal night's agenda.
		// It is still an ABSOLUTE floor in points — the unit the complaint would
		// be made in — not a comparison against the layout's own constant.
		expect(printedDetailPt(contestRows(contestants))).toBeGreaterThanOrEqual(
			EDITORIAL_DENSE_MIN_PRINTED_PT,
		);
	});

	it("FLOWS rather than shrinking, so type stays the same at every size", () => {
		// The fix this suite forced. A contest is far too long to scale onto one
		// sheet: measured at 3.5pt for four contestants and 2.6pt for seven before
		// `MIN_FIT_SCALE` existed. It now prints across several sheets at full
		// size, so all three counts read identically — and the sheet genuinely
		// grows, which the height assertion below pins.
		expect(printedDetailPt(contestRows(4))).toBe(
			printedDetailPt(contestRows(7)),
		);
		expect(agendaHeight(contestRows(7))).toBeGreaterThan(
			agendaHeight(contestRows(4)),
		);
		// And it is a MULTI-sheet agenda, not one that happened to fit.
		expect(agendaHeight(contestRows(4))).toBeGreaterThan(PAGE_H);
	});

	it("measures a non-empty sheet", () => {
		// The unstated zero. Chrome renders a valid, short document for an empty
		// body, and a short sheet needs no scale — which reads as LARGE type and
		// passes every floor above.
		const rows = contestRows(4);
		expect(rows.length).toBeGreaterThan(30);
		// `who` is the beat's ACTIVITY, not the role — the Chief Judge's row reads
		// "Judges' briefing". Identity travels in `roleKey`, which is what the
		// print layouts colour by.
		expect(rows.some((r) => r.roleKey === "chief_judge")).toBe(true);
		expect(rows.some((r) => r.who.startsWith("Judges' briefing"))).toBe(true);
		expect(rows.filter((r) => r.section)).toHaveLength(5);
	});
});
