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
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-rows";
import type { TimelineRow } from "#/lib/agenda-timing";
import { buildTimeline } from "#/lib/agenda-timing";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import {
	CHROME_TEST_TIMEOUT_MS,
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
describe("MIN_FIT_SCALE", { timeout: CHROME_TEST_TIMEOUT_MS }, () => {
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

describe.skipIf(!hasChrome)(
	"editorial agenda density",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
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
	},
);

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
describe.skipIf(!hasChrome)(
	"contest agenda density",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
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
				const n = r.key.startsWith("contestant_")
					? contestants
					: r.defaultCount;
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

		it("FLOWS at full size once long enough, and is never squeezed below the floor", () => {
			// The fix this suite forced. A contest was far too long to scale onto one
			// sheet: measured at 3.5pt for four contestants and 2.6pt for seven before
			// `MIN_FIT_SCALE` existed. Past that threshold a sheet flows across pages
			// at full size instead of shrinking.
			//
			// This USED TO assert 4 and 7 contestants print identically, because the
			// seeded contest ran ~40 rows at four and both flowed. It now runs 21 at
			// four (one contest, not three), which lands BELOW the flow threshold and
			// is scaled onto one sheet instead — so the two sizes legitimately differ
			// and an equality assertion would only be satisfiable by lengthening the
			// contest again.
			//
			// The cliff that leaves is real and is NOT fixed here: a sheet just over
			// one page is squeezed toward the floor, while a longer one flows at full
			// size, so adding rows can make an agenda MORE legible. Raising
			// `MIN_FIT_SCALE` would fix it and would also turn ordinary club agendas
			// into two-pagers, which is a separate decision. Recorded in TODOS.md.
			//
			// Floors carry margin rather than pinning the measurement: this harness
			// resolves no webfonts, and the platform substitute differs between macOS
			// and CI's Ubuntu, which moves where lines wrap.
			const long = printedDetailPt(contestRows(7));
			const short = printedDetailPt(contestRows(4));
			expect(long).toBeGreaterThan(8);
			expect(short).toBeLessThan(long);
			expect(short).toBeGreaterThanOrEqual(EDITORIAL_DENSE_MIN_PRINTED_PT);

			expect(agendaHeight(contestRows(7))).toBeGreaterThan(
				agendaHeight(contestRows(4)),
			);
			// Both are still MULTI-sheet agendas, not ones that happened to fit.
			expect(agendaHeight(contestRows(4))).toBeGreaterThan(PAGE_H);
		});

		it("measures a non-empty sheet", () => {
			// The unstated zero. Chrome renders a valid, short document for an empty
			// body, and a short sheet needs no scale — which reads as LARGE type and
			// passes every floor above.
			const rows = contestRows(4);
			// EXACT, not a floor: the seeded contest is one contest of 15 beats, so
			// four contestants render 21 rows. A `toBeGreaterThan` here passed at 40
			// rows and would pass at 40 again, which is how a template that quietly
			// regrew two contests would slip through this suite.
			expect(rows.length).toBe(21);
			// `who` is the beat's ACTIVITY, not the role — the Chief Judge's row reads
			// "Judges' briefing". Identity travels in `roleKey`, which is what the
			// print layouts colour by.
			expect(rows.some((r) => r.roleKey === "chief_judge")).toBe(true);
			expect(rows.some((r) => r.who.startsWith("Judges' briefing"))).toBe(true);
			expect(rows.filter((r) => r.section)).toHaveLength(3);
		});
	},
);

/**
 * A template at the NEW ceiling (#task-10) — every bound
 * `meeting-template-limits.ts` states, at once: `MAX_TEMPLATE_BEATS` beats
 * over `MAX_TEMPLATE_ROLES` roles, `MAX_ROLE_REPEAT_SLOTS` holders per role,
 * label and detail at their own character caps and built from EMOJI code
 * points (assignee names back off that — see `hostileTemplateRows`'s own
 * docblock for why). Same axes `meeting-template-limits.bench.test.ts`
 * measures render cost against; this measures LEGIBILITY, which page count
 * cannot see and which page count could not see even for the seeded contest
 * above.
 *
 * The seeded contest was the longest agenda this app could produce before
 * the per-meeting editor (Tasks 1-9) existed — an officer could not make one
 * longer than the seed's ~15 beats. That is no longer true: an officer can
 * now build a template at the full ceiling, and the ceiling was chosen for
 * RENDER COST (see the bench file), which says nothing about whether the
 * result still prints legibly. This is the case that answers that.
 */
const HOSTILE_EMOJI = "🐙";
function hostileStr(len: number): string {
	return HOSTILE_EMOJI.repeat(len);
}

/**
 * `hostileTemplateRows`'s beat layout: every one of `beatCount` beats is a
 * NON-repeating role beat, cycling through the declared roles (capped at
 * `MAX_TEMPLATE_ROLES`), each role owning `MAX_ROLE_REPEAT_SLOTS` slots —
 * exercising the holder-list cap `agenda-template-rows.ts` now applies on
 * that branch on every row that has one, rather than on 40 of them and
 * leaving the rest to one repeat block.
 *
 * Deliberately NOT the bench file's construction (a big repeat block over
 * the leftover beats) at `beatCount = MAX_TEMPLATE_BEATS`: that shape
 * expands `MAX_TEMPLATE_BEATS` stored rows into ~16x as many OUTPUT rows
 * (measured: 3,240 for this template's exact numbers), and dumping a DOM
 * that size through headless Chrome's `--dump-dom` overflowed
 * `execFileSync`'s pipe on this machine (`ENOBUFS`) — a harness limit, not
 * a claim about the app. All-non-repeating keeps the output at exactly
 * `beatCount` rows while still declaring the full `MAX_TEMPLATE_ROLES` /
 * `MAX_ROLE_REPEAT_SLOTS` / label / detail ceilings at once regardless of
 * `beatCount` — the ceiling case (`beatCount = MAX_TEMPLATE_BEATS`, the
 * default) is still far longer than the seeded contest's ~15 beats, which
 * is the property THAT case exists to cover. The squeeze-zone case below
 * calls this with a much smaller `beatCount` instead, for a different
 * property — see that describe block's own docblock.
 */
function hostileTemplateRows(
	beatCount: number = MAX_TEMPLATE_BEATS,
	holdersPerRow: number = MAX_ROLE_REPEAT_SLOTS,
): TimelineRow[] {
	const roles: TemplateRoleRow[] = Array.from(
		{ length: MAX_TEMPLATE_ROLES },
		(_, i) => ({
			key: `role_${i}`,
			name: `Role ${i}`,
			isSpeakerRole: false,
		}),
	);
	const label = hostileStr(MAX_TEMPLATE_LABEL_CHARS);
	const detail = hostileStr(MAX_TEMPLATE_DETAIL_CHARS);
	const beats: TemplateBeatRow[] = Array.from(
		{ length: beatCount },
		(_, i) => ({
			sortOrder: i,
			kind: "role",
			label,
			detail,
			minutes: 5,
			roleKey: roles[i % roles.length]?.key ?? null,
			repeatsRoleKey: null,
			flex: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
		}),
	);
	// Assignee names LONG (the axis the two-page-layout suite below also uses
	// this length for), but deliberately NOT at their own real ceiling
	// (`MAX_NAME_CHARS` = 200, `person-name.ts`, exercised at scale in
	// `meeting-template-limits.bench.test.ts`, which never touches Chrome).
	// `MAX_ROLE_REPEAT_SLOTS` holders × 200 code points EACH joined onto one
	// row, times `MAX_TEMPLATE_BEATS` such rows, serializes into a DOM
	// `--dump-dom` cannot get back through `execFileSync`'s pipe on this
	// machine: measured `ENOBUFS` at exactly this beat/role/slot count, with
	// ONLY the holder name length reduced from 200 code points to the short
	// name below — everything else here unchanged. That is a harness plumbing
	// limit, not a claim about the app: the render-cost bench file proves the
	// RENDERER handles 200-code-point names at this same scale in ~20ms with
	// no browser involved. This axis still holds MAX_ROLE_REPEAT_SLOTS holders
	// per row; only their NAME LENGTH backs off to stay inside the harness.
	const slots: AgendaSlot[] = [];
	for (const role of roles) {
		for (let i = 0; i < holdersPerRow; i++) {
			slots.push({
				id: `${role.key}-${i}`,
				roleName: role.name,
				roleKey: role.key,
				category: "functionary",
				isSpeakerRole: false,
				slotIndex: i,
				assigneeName: `${hostileStr(4)}Anneliese Vandermeer-Castellanos ${i}`,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			});
		}
	}
	return buildTimeline(
		resolveAgendaRows({
			geIntroducesFunctionaries: false,
			template: { beats, roles },
			slots,
		}),
		new Date("2026-09-12T13:00:00Z"),
		"America/Chicago",
	);
}

describe.skipIf(!hasChrome)(
	"worst-case template density (#task-10)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("prints legible body text even at the full template ceiling", () => {
			const rows = hostileTemplateRows();
			// A control, same idiom as the contest suite above: proves the fixture
			// actually produced content before trusting a point-size floor built
			// from its height.
			expect(rows.length).toBeGreaterThan(0);
			// Measured 8.63pt — exactly the declared 11.5px × 0.75, i.e. FULL
			// declared size with NO scale applied at all: at `MAX_TEMPLATE_BEATS`
			// rows this sheet is already well past `MIN_FIT_SCALE`'s flow
			// threshold, so it flows across pages instead of being squeezed. That
			// is a real, useful thing for this case to prove (a maximal template
			// does not silently get shrunk to nothing), but it means this
			// assertion is NOT exercising the tightest squeeze — the contest
			// suite above already covers that zone (short of one page, where
			// `FitPage` scales hardest) at a fixture size closer to it. Keep both:
			// this one changes if the flow threshold, the declared size, or this
			// template's own row count ever move enough to cross back over it.
			expect(printedDetailPt(rows)).toBeGreaterThanOrEqual(
				EDITORIAL_DENSE_MIN_PRINTED_PT,
			);
		});

		/**
		 * The case above proves the CEILING is safe; it does not prove the
		 * DANGEROUS size is, because it lands in the wrong branch. `FitPage`
		 * SQUEEZES a sheet taller than one page down toward `MIN_FIT_SCALE`
		 * (0.72) and then, past that point, gives up and FLOWS at full
		 * declared size instead — so the worst printed type size is not at
		 * the largest content, it is at the largest content that still
		 * squeezes, just before that cliff. `TODOS.md` already records this
		 * cliff as a known gap; the pre-existing "contest agenda density"
		 * suite above sits in it too, but only with BENIGN content (short
		 * ASCII labels, ordinary names) — "squeeze zone + hostile axes" was
		 * untested, and that combination is exactly what an officer can now
		 * author that the seed never could.
		 *
		 * Sized empirically, not guessed. Every row here carries max-length
		 * emoji label and detail (`MAX_TEMPLATE_LABEL_CHARS` /
		 * `MAX_TEMPLATE_DETAIL_CHARS`) — that alone is what the beat count
		 * and holder count below are tuned AROUND, since two such rows at
		 * full holders already overshoot the squeeze zone entirely. Measured
		 * directly while sizing this case (`hostileTemplateRows(beats,
		 * holders)`, Apple M2 Max, 2026-08-22):
		 *
		 *     beats=1 holders=20  height=1057  raw=0.997  (barely squeezed)
		 *     beats=2 holders=0   height=1074  raw=0.981
		 *     beats=2 holders=10  height=1368  raw=0.770
		 *     beats=2 holders=12  height=1444  raw=0.730  ← chosen
		 *     beats=2 holders=13  height=1486  raw=0.709  (already FLOWS)
		 *     beats=2 holders=20  height=1696  raw=0.621  (flows; the
		 *                                                   ceiling case above
		 *                                                   is deep in here)
		 *
		 * 12 holders is the largest integer holder count for which two
		 * max-label/max-detail/emoji rows still land ABOVE `MIN_FIT_SCALE`
		 * rather than flowing — one more holder each and the fixture flips
		 * branches entirely (0.709 < 0.72). It is not `MAX_ROLE_REPEAT_SLOTS`
		 * (20): at 20, per the table above, this same two-row shape already
		 * flows, which is the opposite of what this case needs to prove. Do
		 * NOT "fix" this by raising it back toward 20 or by adding more
		 * beats — either makes the fixture bigger, which pushes it further
		 * PAST the danger zone, not into it. If a future change to the
		 * declared type size, `MIN_FIT_SCALE`, or these two beats' own
		 * content ever moves the achieved `raw` outside roughly [0.72, 0.75),
		 * this fixture needs re-sizing the same way: shrink content until it
		 * just barely stops flowing, not the reverse.
		 */
		it("prints legible body text at the worst achievable squeeze, not just at the ceiling", () => {
			const rows = hostileTemplateRows(2, 12);
			expect(rows.length).toBeGreaterThan(0);
			// Confirms this landed in the SQUEEZE branch, not the flow branch —
			// without this, a future change that accidentally made the fixture
			// flow (see the docblock above) would still pass the floor below
			// while testing nothing new versus the ceiling case.
			//
			// IF THE NEXT TWO ASSERTIONS ARE WHAT WENT RED ON CI: RETUNE, DO NOT
			// REVERT. The margin above the cliff is ~1.4% (raw ≈ 0.730 against a
			// 0.72 floor, measured on macOS), and this repo has a DOCUMENTED
			// cross-platform delta of comparable size on a similar fixture —
			// 6.88pt macOS vs 6.799pt Linux, ~1.2%, from font substitution moving
			// wrap points (see this file's header and `agenda-print-type.ts`). So
			// the fixture flipping into the flow branch on CI's Ubuntu was a KNOWN
			// and accepted risk when it was sized, not a surprise and not a code
			// defect. Accepted rather than pre-tuned for three reasons: it fails
			// LOUDLY here instead of quietly measuring the wrong branch; guessing
			// Linux metrics from macOS numbers means guessing from the same side
			// of the same variance that caused the problem, whereas a red CI hands
			// over the real Linux number; and the tightest squeeze is where
			// printed type is smallest, so moving to a safer mid-band raw (~0.85)
			// would weaken precisely what the floor assertion proves. The correct
			// response is the sizing recipe in the docblock above — shrink content
			// until it just barely stops flowing — using the OBSERVED Linux
			// height.
			const raw = (PAGE_H - 2) / agendaHeight(rows);
			expect(raw).toBeGreaterThanOrEqual(MIN_FIT_SCALE);
			expect(raw).toBeLessThan(0.75);
			// Measured 6.30pt at raw≈0.730 — the worst printed size this
			// hostile-content shape can be squeezed to before `FitPage` gives
			// up and flows instead. Still comfortably above the dense floor.
			expect(printedDetailPt(rows)).toBeGreaterThanOrEqual(
				EDITORIAL_DENSE_MIN_PRINTED_PT,
			);
		});
	},
);

/**
 * Naming the group on a hand-off costs no type size on the TWO-PAGE layouts
 * (#578).
 *
 * #585 measured the opposite for the one-page layouts and was right: there the
 * run of show shares one 1056px sheet with the header band, the roles legend,
 * the officers and the footer, so editorial already scales to ~0.8, and a
 * comma-joined list of 2-5 members is the longest line on the page. `FitPage`
 * scales the WHOLE sheet to fit it — 6.470pt of printed body with the names
 * against 6.799pt without, on a 6.2pt floor. So the one-page layouts still
 * ignore `AgendaRow.introduces`.
 *
 * Spacious and timing put the run of show on a sheet of its OWN, which changes
 * the arithmetic rather than the argument. This asserts the changed arithmetic
 * directly: with the names, that sheet still fits `PAGE_H`, so `FitPage` never
 * scales it, so nothing shrinks. Assert the HEIGHT rather than a point size
 * because that is the mechanism — under `PAGE_H` there is no transform at all,
 * and the declared sizes print as declared.
 *
 * The fixture is hostile on the axis that matters, per CLAUDE.md's
 * fixture-matrix rule: five speakers (the top of the range a club runs) with
 * 30-character double-barrelled names, which is the longest content this line
 * can hold. A two-speaker fixture with short names would pass while proving
 * nothing.
 */
describe.skipIf(!hasChrome)(
	"group hand-off names on the two-page layouts",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		const LONG_NAMES = [
			"Bartholomew Fotheringay-Smythe",
			"Anastasia Vasilievna Kuznetsova",
			"Maximilian Oppenheimer-Rothschild",
			"Wilhelmina Ashworth-Pemberton",
			"Konstantinos Papadopoulos-Nikolaidis",
		];

		function handoffRows(introduces: string[] | undefined): TimelineRow[] {
			const out: TimelineRow[] = [
				{
					who: "Toastmaster of the Day · Ali",
					roleKey: "toastmaster_of_the_day",
					detail: "Introduces the speakers",
					minutes: 0,
					marks: null,
					handoff: true,
					time: "6:53",
					...(introduces ? { introduces } : {}),
				},
			];
			LONG_NAMES.forEach((n, i) => {
				out.push({
					who: `Speaker ${i + 1} · ${n}`,
					roleKey: "speaker",
					detail: "Prepared speech",
					minutes: 7,
					marks: { green: 5, yellow: 6, red: 7 },
					time: "7:00",
				});
			});
			return out;
		}

		/**
		 * The natural height of the RUN-OF-SHOW sheet — page 2 — on a two-page layout.
		 *
		 * The nth-sheet selector `agendaHeight`'s doc comment says to add
		 * deliberately rather than by parameterising it: `[data-fit-inner]` matches
		 * the FIRST sheet, and on these layouts that is the cover, so measuring it
		 * would give a confident, wrong, much smaller number. Both `.agenda-page`
		 * divs are siblings inside `TwoPage`'s `.pgwrap`, so `:nth-of-type(2)` picks
		 * the run of show. (Verified: the naive selector reported 493px and a delta of
		 * 0 for both layouts — it was measuring a cover page with no hand-off on it.)
		 */
		function runSheetHeight(
			rows: TimelineRow[],
			layout: "spacious" | "timing",
		): number {
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
				".agenda-page:nth-of-type(2) [data-fit-inner]",
			);
		}

		/**
		 * ONE test per layout, and it was two until CI said otherwise.
		 *
		 * Every `measuredHeight` spawns a fresh Chrome with its own
		 * `--user-data-dir`. Split across two cases this measured the same
		 * with-names sheet twice per layout — six spawns for four distinct
		 * numbers — and because vitest runs test FILES in parallel, concurrent
		 * spawns slow each other down. That is how a sibling test in this file
		 * (`MIN_FIT_SCALE`, one measurement) took 16.5s against the 15s ceiling on
		 * a CI runner while passing locally in 2.5s. The ceiling was not the
		 * problem; six spawns for four numbers was.
		 *
		 * Both claims read the same two measurements, so they belong in one case.
		 */
		it.each([
			"spacious",
			"timing",
		] as const)("%s prints the names for a line of height and no type size", (layout) => {
			const without = runSheetHeight(handoffRows(undefined), layout);
			const withNames = runSheetHeight(handoffRows(LONG_NAMES), layout);

			// The whole claim: under PAGE_H there is no transform at all, so
			// nothing shrinks. Measured 658px (spacious) and 547px (timing)
			// against 1056.
			expect(withNames).toBeLessThan(PAGE_H);
			// A control, so the assertion above cannot pass on an empty sheet.
			expect(withNames).toBeGreaterThan(200);

			// Measured 31px (spacious) and 13px (timing) — one wrapped line. An
			// ABSOLUTE ceiling, not `withNames > without`: the point is that the
			// cost is a line, and a relative assertion passes at any cost at all.
			expect(withNames - without).toBeLessThan(120);
			// And it costs SOMETHING, which proves the names actually rendered on
			// this layout rather than the field being silently ignored.
			expect(withNames).toBeGreaterThan(without);
		});
	},
);
