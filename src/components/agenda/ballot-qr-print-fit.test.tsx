/**
 * How large the ballot QR actually PRINTS, and what it costs the sheet (#717).
 *
 * Two directions, and the first review of #717 caught this file holding only
 * one of them. The bug the issue was filed about is a code too SMALL to scan;
 * the regression fixing it can ship is a sheet too TALL to stay on one page. A
 * file of ceilings gets looser as the code shrinks, so every ceiling here
 * passes at the 8mm defect. Both directions are mutation-checked below.
 *
 * Neither is visible to any other gate in this repo:
 *
 *   · `meeting-agenda-print.test.tsx` asserts the DECLARED edge off the rendered
 *     `<svg>`. jsdom performs no layout, so it cannot say what the square then
 *     does to the page around it — or what the page then does to the square.
 *   · `print-page-count.test.tsx` renders these layouts WITH a `ballotUrl` and
 *     counts sheets — but its own header explains why that count cannot move:
 *     `FitPage`'s scale-and-flow decision is a `useEffect`, static SSR markup
 *     never mounts React, so every `.agenda-page` there stays `height: PAGE_H;
 *     overflow: hidden` and content volume provably cannot add a page.
 *   · `print-density.test.tsx` measures exactly the right thing — the natural
 *     height `FitPage` reads — but every fixture in it renders with NO
 *     `ballotUrl` at all. So the QR is invisible to it, and the margin it
 *     reports for editorial is the margin of a sheet the app does not print.
 *
 * MUTATED IN BOTH DIRECTIONS, because arguing it is not the same as showing it.
 * Run `print-page-count` and `print-density` together on any of the three
 * mutations below and they report 37 passing — blind downward AND upward. This
 * file fails each one:
 *
 *   FOOTER_QR_PX = 32 (the shipped defect) ... printed edges 23.6px on
 *       editorial and 24.0px on grid, under the 32px floor. 1 case, naming both.
 *   FOOTER_QR_PX = 64 ........................ editorial 12.9px from the flow
 *       cliff, under one wrapped line of platform variance. 1 case.
 *   FOOTER_QR_PX = 80 ........................ editorial 3.1px PAST the cliff:
 *       the club's one-page agenda becomes two. 2 cases.
 *
 * WHY THE PRINTED EDGE IS NOT THE DECLARED ONE. Both one-page layouts sit
 * inside `FitPage`, which scales the whole sheet by `(PAGE_H - 2) / height`, so
 * a 56px code prints at 41px on editorial. That factor is also why a ceiling
 * cannot stand in for a floor: shrink the code and the sheet gets shorter, the
 * scale gets larger, and every ceiling in this file gets MORE slack.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT. The two ONE-PAGE layouts, because they are
 * the ones inside `FitPage` with something to lose, plus the page 1 of each
 * two-sheet layout, because those are the sheets #717 put a code on. `spacious`
 * page 2 is left out: it is already past the flow cliff on this agenda (1501px)
 * before any of this, so a QR cannot push it over something it is already over,
 * and a case that cannot fail is worse than no case.
 *
 * Same harness and the same caveat as its two neighbours: no webfonts resolve
 * here, the platform substitute differs between macOS and CI's Ubuntu and moves
 * where lines wrap, so every bound below carries margin instead of pinning the
 * measurement.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	EDITORIAL_MIN_PRINTED_PT,
	pxToPt,
	RUN_NARRATIVE_TYPE,
} from "#/lib/agenda-print-type";
import {
	MCF_BALLOT_URL,
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
} from "#/test/print-page-count";
import { type AgendaLayout, MeetingAgendaPrint } from "./meeting-agenda-print";
import {
	FOOTER_QR_PX,
	MIN_FIT_SCALE,
	PAGE_H,
	PRINT_PAGE_CSS,
} from "./print-theme";

/**
 * The floor on what the club's printer puts on paper, in CSS px at the 96dpi
 * `@page` assumes. 32px is 8.5mm.
 *
 * ABSOLUTE, and stated in the unit the complaint was made in, for the reason
 * `EDITORIAL_MIN_PRINTED_PT` gives about its own floor: a bound stated against
 * `FOOTER_QR_PX` moves with the number it is meant to constrain and can never
 * fail. This one fails at 32.
 *
 * The value is chosen to be memorable rather than derived: the code must now
 * PRINT at least as large as the old one was DECLARED. That old declared 32
 * printed at 23.6px on editorial once `FitPage` had scaled the sheet, which is
 * the ~0.2mm module #717 was filed about. Today's `FOOTER_QR_PX` clears this by
 * 8.9px on the tightest surface — wide enough that the ~3% the platform's
 * substitute font moves the scale cannot reach it.
 *
 * Lowering this is a decision to print a code a phone struggles with. Make it
 * with a fresh measurement, not to turn a red test green.
 */
const MIN_PRINTED_QR_PX = 32;

/**
 * How much room a one-page layout must keep between its natural height and the
 * height at which `FitPage` gives up and flows it onto a second sheet.
 *
 * 16px is one wrapped line, which is the unit of cross-platform variance this
 * harness actually has: `agenda-print-type.ts` records that no webfont resolves
 * here, that the platform substitute differs between macOS and CI's Ubuntu, and
 * that each extra wrapped line is ~16px of sheet. A layout standing closer than
 * one line to the cliff is one wrap away from costing the club a sheet on a
 * machine that is not this one.
 *
 * This is the bound that decides `FOOTER_QR_PX`, and it is deliberately NOT the
 * "costs the footer almost nothing" delta below — that one was authored in the
 * same change as the constant and calibrated against it, so treating it as the
 * size constraint would be circular. Measured against this rule instead, on the
 * real agenda: 56 leaves editorial 20.9px, 64 leaves 12.9px, 72 leaves 4.9px.
 * 56 is the largest size that passes, and it is also MORE margin than the 18.9px
 * the 32px code has on `main` today — so the bigger code does not spend any of
 * editorial's safety, it adds to it.
 */
const MIN_FLOW_SLACK_PX = 16;

/**
 * The natural height at which `FitPage` stops scaling a sheet and lets it flow
 * across pages instead — `MIN_FIT_SCALE`'s threshold, expressed as the height
 * it corresponds to so the assertions below can be stated in pixels.
 *
 * Derived from the two constants `FitPage` itself branches on rather than
 * hardcoded, because the answer to "does this agenda still print on one sheet"
 * has to be asked the same way the runtime asks it.
 */
const FLOW_HEIGHT = (PAGE_H - 2) / MIN_FIT_SCALE;

/**
 * The factor `FitPage` will apply to a sheet of this natural height — and
 * therefore to everything printed on it, the QR included.
 *
 * Three branches, all of them real. Over `PAGE_H` it scales to fit. Under
 * `PAGE_H` there is no transform at all, so a sheet that already fits prints at
 * its declared sizes. And past `MIN_FIT_SCALE` it stops scaling and FLOWS,
 * which also prints at declared size — the branch `printedDetailPt` in
 * `print-density.test.tsx` mirrors for the same reason.
 */
function printScale(sheetHeight: number): number {
	const raw = (PAGE_H - 2) / sheetHeight;
	if (raw >= 1) return 1;
	return raw < MIN_FIT_SCALE ? 1 : raw;
}

function sheetHtml(layout: AgendaLayout, ballotUrl?: string): string {
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={MCF_HEADER}
			roles={MCF_ROLES}
			officers={MCF_OFFICERS}
			explainers={MCF_EXPLAINERS}
			rows={MCF_ROWS}
			ballotUrl={ballotUrl}
		/>,
	);
}

/**
 * Every sheet this file asks about, in ONE document and therefore one browser
 * launch. Each launch is a Chrome process on a runner slower and more contended
 * than a laptop, and #624 measured what a file that launches generously does to
 * its NEIGHBOURS: fifteen launches took a sibling test from 8.5s to 75s against
 * a 60s ceiling, green locally and red in CI.
 *
 * Wrapping each sheet in a plain div is safe for HEIGHT — `PRINT_PAGE_CSS`
 * selects `.agenda-page` and `.pgwrap` by class, never as a child of `body`. It
 * would NOT be safe for a page COUNT, because `.agenda-page:last-child` then
 * matches once per wrapper.
 */
const PARTS: readonly { id: string; layout: AgendaLayout; qr: boolean }[] = [
	{ id: "ed-qr", layout: "editorial", qr: true },
	{ id: "ed-none", layout: "editorial", qr: false },
	{ id: "gr-qr", layout: "grid", qr: true },
	{ id: "gr-none", layout: "grid", qr: false },
	{ id: "tm-qr", layout: "timing", qr: true },
	{ id: "sp-qr", layout: "spacious", qr: true },
	{ id: "sp-none", layout: "spacious", qr: false },
];

/**
 * Selectors by NAME, not by position.
 *
 * The first cut of this file destructured an eight-long array, which coupled
 * every assertion to the order of a list edited somewhere else in the file, and
 * defaulted each to `0` — so a selector that came back empty made
 * `grQr - grNone > edQr - edNone` pass on two zeroes. `measure` below throws
 * instead.
 *
 * `.agenda-page:nth-of-type(n)` on the two-sheet layouts because
 * `[data-fit-inner]` alone matches the first sheet of the whole DOCUMENT, which
 * across seven wrapped surfaces is never the one meant.
 */
const SELECTORS = {
	edSheetQr: "#ed-qr [data-fit-inner]",
	edSheetNone: "#ed-none [data-fit-inner]",
	edBandQr: "#ed-qr [data-print-footer]",
	edBandNone: "#ed-none [data-print-footer]",
	edQrBox: "#ed-qr .footer-qr",
	grSheetQr: "#gr-qr [data-fit-inner]",
	grSheetNone: "#gr-none [data-fit-inner]",
	grQrBox: "#gr-qr .footer-qr",
	tmSheet1Qr: "#tm-qr .agenda-page:nth-of-type(1) [data-fit-inner]",
	tmQrBox1: "#tm-qr .agenda-page:nth-of-type(1) .footer-qr",
	spSheet1Qr: "#sp-qr .agenda-page:nth-of-type(1) [data-fit-inner]",
	spSheet1None: "#sp-none .agenda-page:nth-of-type(1) [data-fit-inner]",
	spQrBox1: "#sp-qr .agenda-page:nth-of-type(1) .footer-qr",
} as const;

type Measured = Record<keyof typeof SELECTORS, number>;

/**
 * Memoized, and called from inside the cases rather than from the describe
 * body — `describe.skipIf` still EVALUATES its callback to collect the tests it
 * is about to skip, so measuring there would launch a browser (or throw for
 * want of one) on exactly the machines the skip exists for.
 */
let cached: Measured | null = null;
function measure(): Measured {
	if (cached) return cached;
	const body = PARTS.map(
		(p) =>
			`<div id="${p.id}">${sheetHtml(
				p.layout,
				p.qr ? MCF_BALLOT_URL : undefined,
			)}</div>`,
	).join("");
	const names = Object.keys(SELECTORS) as (keyof typeof SELECTORS)[];
	const heights = measuredHeights(
		printableDocument(PRINT_PAGE_CSS, body),
		names.map((n) => SELECTORS[n]),
	);
	const out = {} as Measured;
	names.forEach((name, i) => {
		const h = heights[i];
		// `measuredHeights` already throws on a selector that matches nothing. A
		// ZERO is the other way a measurement goes missing — an inline box reports
		// `scrollHeight` 0 — and zero is the value every bound in this file is
		// happiest with, so it has to be fatal here rather than assertable later.
		if (!h || h <= 0) {
			throw new Error(
				`Measured ${h} for ${name} (${SELECTORS[name]}). A zero height is ` +
					"not a measurement — every ceiling in this file would pass on it.",
			);
		}
		out[name] = h;
	});
	cached = out;
	return out;
}

const hasChrome = findChrome() !== null;

describe("ballot QR print-fit harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every measurement here would skip and the suite " +
				"would still report green — which reads exactly like a passing " +
				"geometry gate.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the printed ballot QR and the sheets it sits on",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		// ------------------------------------------------------------------
		// THE FLOOR — the defect #717 was actually filed about.
		// ------------------------------------------------------------------

		it("prints a code big enough to scan on every layout that carries one", () => {
			const m = measure();
			// Four surfaces, four different scales, one absolute floor. Measured:
			// editorial 40.9px (scale 0.730), grid 41.3px (0.737), timing page 1
			// 56px and spacious page 1 56px (both under PAGE_H, so no transform at
			// all). The two one-page layouts are the tight ones and the reason the
			// floor is stated on the PRINTED number rather than on `FOOTER_QR_PX`:
			// the constant is identical on all four and what reaches paper is not.
			const printed = {
				editorial: m.edQrBox * printScale(m.edSheetQr),
				grid: m.grQrBox * printScale(m.grSheetQr),
				"timing page 1": m.tmQrBox1 * printScale(m.tmSheet1Qr),
				"spacious page 1": m.spQrBox1 * printScale(m.spSheet1Qr),
			};
			// Collected rather than asserted one at a time, so a failure names EVERY
			// surface that is too small instead of stopping at the first. The
			// difference matters when this fails: "editorial is 23.6px" reads like
			// one layout's problem, and the shipped defect was all four.
			const tooSmall = Object.entries(printed)
				.filter(([, px]) => px < MIN_PRINTED_QR_PX)
				.map(([surface, px]) => `${surface} ${px.toFixed(1)}px`);
			expect(
				tooSmall,
				`printed edges below the ${MIN_PRINTED_QR_PX}px floor`,
			).toEqual([]);
		});

		it("renders the constant's square through a real layout engine", () => {
			const m = measure();
			// A wiring check, NOT the floor above — it tracks `FOOTER_QR_PX` and so
			// passes at any value the constant could hold. What it adds over the
			// jsdom assertion in `meeting-agenda-print.test.tsx` is that the browser
			// BOXES the square at that edge: a `<svg width>` that CSS then overrode
			// would pass there and fail here.
			for (const box of [m.edQrBox, m.grQrBox, m.tmQrBox1, m.spQrBox1]) {
				expect(box).toBeGreaterThanOrEqual(FOOTER_QR_PX);
			}
		});

		// ------------------------------------------------------------------
		// THE CEILING — the regression raising the code can ship.
		// ------------------------------------------------------------------

		it("keeps both one-page agendas on ONE sheet, a wrapped line clear of the cliff", () => {
			const m = measure();
			// Measured 20.9px of slack on editorial and 33.9px on grid, against
			// `MIN_FLOW_SLACK_PX`. This is the bound that picked `FOOTER_QR_PX`:
			// 64 leaves editorial 12.9px and 72 leaves 4.9px, both under one wrapped
			// line of the variance this harness carries.
			//
			// Grid is the layout with the least to give and the one a club gets by
			// default: it hand-rolls its officer band, so unlike `DarkFooter` there
			// is no disclaimer for the code to sit beside and ride for free — the
			// full square lands on the sheet.
			//
			// The floors are not decorative. A sheet SHORTER than the page needs no
			// scale at all, so it would clear the slack bound while proving nothing
			// about the squeeze band this agenda actually lives in.
			for (const [name, h] of [
				["editorial", m.edSheetQr],
				["grid", m.grSheetQr],
			] as const) {
				expect(h, `${name} is not in the squeeze band at all`).toBeGreaterThan(
					PAGE_H,
				);
				expect(
					FLOW_HEIGHT - h,
					`${name} stands ${(FLOW_HEIGHT - h).toFixed(1)}px from the flow cliff`,
				).toBeGreaterThan(MIN_FLOW_SLACK_PX);
			}
		});

		it("still prints the editorial body text large enough to read", () => {
			const m = measure();
			// `print-density.test.tsx` holds this exact floor, on this exact
			// agenda, and cannot see this: its fixtures pass no `ballotUrl`, so it
			// measures a sheet with no QR on it. Measured 6.300pt here against
			// 6.366pt for the QR-less sheet that suite reports — and against
			// 6.291pt for what `main` prints today, so the bigger code is also a
			// slightly MORE legible agenda, not a trade.
			expect(
				pxToPt(RUN_NARRATIVE_TYPE.sm.detail * printScale(m.edSheetQr)),
			).toBeGreaterThanOrEqual(EDITORIAL_MIN_PRINTED_PT);
		});

		// ------------------------------------------------------------------
		// THE STRUCTURE that makes both of the above satisfiable at once.
		// ------------------------------------------------------------------

		it("hangs the code beside the footer stack, where it costs almost nothing", () => {
			const m = measure();
			// Measured on the BAND, not inferred from the sheet: a sheet-height
			// delta cannot tell a footer that grew from a run of show that did.
			//
			// The QR is a flex sibling of the ENTIRE `DarkFooter` stack — the
			// left/right line and the two-line disclaimer both — so a square up to
			// ~41px is free and 56 costs 15px. Put it back inside the left/right
			// row, where #510 had it, and the band takes the square's full height:
			// 41px, which is what carried editorial over the cliff.
			//
			// An absolute pixel ceiling rather than one stated against
			// `FOOTER_QR_PX`, which would move with the number it constrains. This
			// is NOT what picked that number — see `MIN_FLOW_SLACK_PX` — it is what
			// keeps the structure that made the number affordable.
			expect(m.edBandQr - m.edBandNone).toBeLessThanOrEqual(24);

			// The contrast that makes the line above a measurement rather than a
			// coincidence: grid has no stack for the code to hide in, so its sheet
			// takes the whole square. Measured 43px against editorial's 15.
			expect(m.grSheetQr - m.grSheetNone).toBeGreaterThan(
				m.edSheetQr - m.edSheetNone,
			);
		});

		it("leaves the footer band alone when there is no ballot URL (AC 7)", () => {
			const m = measure();
			// #717 AC 7: with no ballot URL the footers render exactly as they did.
			// The jsdom suite pins the DOM half (`.footer-qr` is absent); this pins
			// the half that matters to a printed page — the band does not GROW.
			//
			// Measured 63px, and stated as an absolute ceiling rather than against
			// the with-QR band: 84 leaves room for the disclaimer wrapping to a
			// third line on a platform whose substitute font is wider, which is
			// variance rather than regression. A block-level addition below the
			// band — the shape `print-page-reset.guard.test.ts` exists for — would
			// blow straight through it.
			//
			// Deliberately NOT paired with `bandNone < bandQr`. That reads like a
			// control and is not one: it asserts the code OVERHANGS the stack it
			// sits beside, which is true at 56 and false at any size the stack
			// already covers — so it fails on a shrink, for a reason nobody cares
			// about, and the floor case above is the assertion that should catch a
			// shrink. Non-vacuity here comes from the QR box being measured
			// directly.
			expect(m.edBandNone).toBeLessThanOrEqual(84);
		});

		// ------------------------------------------------------------------
		// THE TWO-SHEET LAYOUTS — the page-1 sheets #717 put a code on.
		// ------------------------------------------------------------------

		it("prints the page-1 code of both two-sheet layouts at full size", () => {
			const m = measure();
			// #717's other half, and the issue's premise was wrong about its
			// scope: BOTH `timing` and `spacious` print two sides, and both had a
			// page 1 with no route to the ballot. A club printing either
			// double-sided handed out a front side nobody could vote from.
			//
			// Both sheets have room — measured 928px and 890px of 1056 — so
			// `FitPage` applies no transform and the code prints at its declared
			// edge. The floor case above already holds them to the printed number;
			// this holds the reason it is the full one.
			for (const [name, h] of [
				["timing page 1", m.tmSheet1Qr],
				["spacious page 1", m.spSheet1Qr],
			] as const) {
				expect(h, `${name} is an empty sheet, not a real one`).toBeGreaterThan(
					300,
				);
				expect(
					h,
					`${name} is being scaled, so its code is not full size`,
				).toBeLessThan(PAGE_H);
			}
		});

		it("adds spacious page 1's code for no height at all", () => {
			const m = measure();
			// The officer band on that sheet is ~159px tall — an officer grid plus
			// the meeting schedule — so a `FOOTER_QR_PX` square placed beside it
			// fits inside the height the band already had. Measured 890px with the
			// code and 890px without: exactly zero.
			//
			// Stated as a small ceiling rather than `=== 0` so a platform that
			// wraps the officer grid differently does not fail for the wrong
			// reason, and it is the assertion that fails if someone moves this code
			// under the band instead of beside it.
			expect(m.spSheet1Qr - m.spSheet1None).toBeLessThanOrEqual(4);
		});
	},
);
