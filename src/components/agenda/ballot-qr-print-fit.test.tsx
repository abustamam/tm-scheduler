/**
 * What the printed ballot QR costs the sheet it sits on (#717).
 *
 * The size of that code is not a cosmetic number, and it is not a number any
 * other gate in this repo can see:
 *
 *   · `meeting-agenda-print.test.tsx` asserts the DECLARED edge off the rendered
 *     `<svg>`. jsdom performs no layout, so it cannot say what the square then
 *     does to the page around it.
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
 * The gap that leaves is not theoretical, and not argued — mutated. With the
 * footer as #510 built it, raising the code from 32px to 56px put the editorial
 * sheet at 1469px against the 1464px where `FitPage` gives up squeezing and
 * FLOWS onto a second page; with the footer as it is now, `FOOTER_QR_PX` at 80
 * does the same at 1467px. Run those two suites on either mutation and they
 * report 37 passing: the count still reads 1 (it structurally cannot read
 * anything else), the density floor still passes (it is measuring a QR-less
 * sheet), and the club's one-page agenda has quietly become two. This file
 * fails the 80 four separate ways.
 *
 * It measures the two ONE-PAGE layouts, because they are the ones inside
 * `FitPage` with something to lose, plus `timing`'s page 1, which is the sheet
 * #717 added a QR to. `spacious` is left out deliberately: its run-of-show
 * sheet is already past the flow cliff on this agenda (1503px before any of
 * this), so a QR cannot push it over something it is already over, and a case
 * that cannot fail is worse than no case.
 *
 * Same harness and the same caveat as its two neighbours: no webfonts resolve
 * here, the platform substitute differs between macOS and CI's Ubuntu and moves
 * where lines wrap, so the ceilings below carry margin instead of pinning the
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
 * The natural height at which `FitPage` stops scaling a sheet and lets it flow
 * across pages instead — `MIN_FIT_SCALE`'s threshold, expressed as the height
 * it corresponds to so the assertions below can be stated in pixels.
 *
 * Derived from the two constants `FitPage` itself branches on rather than
 * hardcoded, because the answer to "does this agenda still print on one sheet"
 * has to be asked the same way the runtime asks it.
 */
const FLOW_HEIGHT = (PAGE_H - 2) / MIN_FIT_SCALE;

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
];

const SELECTORS = [
	"#ed-qr [data-fit-inner]",
	"#ed-none [data-fit-inner]",
	"#gr-qr [data-fit-inner]",
	"#gr-none [data-fit-inner]",
	"#ed-qr .footer-qr",
	"#gr-qr .footer-qr",
	// `timing`'s page 1 — `[data-fit-inner]` alone matches the FIRST sheet of a
	// document, which across five wrapped surfaces is not the one meant.
	"#tm-qr .agenda-page:nth-of-type(1) [data-fit-inner]",
	"#tm-qr .agenda-page:nth-of-type(1) .footer-qr",
] as const;

type Measurements = {
	edQr: number;
	edNone: number;
	grQr: number;
	grNone: number;
	edQrBox: number;
	grQrBox: number;
	tmPage1: number;
	tmPage1QrBox: number;
};

/**
 * Memoized, and called from inside the cases rather than from the describe
 * body — `describe.skipIf` still EVALUATES its callback to collect the tests it
 * is about to skip, so measuring there would launch a browser (or throw for
 * want of one) on exactly the machines the skip exists for.
 */
let cached: Measurements | null = null;
function measure(): Measurements {
	if (cached) return cached;
	const body = PARTS.map(
		(p) =>
			`<div id="${p.id}">${sheetHtml(
				p.layout,
				p.qr ? MCF_BALLOT_URL : undefined,
			)}</div>`,
	).join("");
	const [
		edQr = 0,
		edNone = 0,
		grQr = 0,
		grNone = 0,
		edQrBox = 0,
		grQrBox = 0,
		tmPage1 = 0,
		tmPage1QrBox = 0,
	] = measuredHeights(printableDocument(PRINT_PAGE_CSS, body), SELECTORS);
	cached = {
		edQr,
		edNone,
		grQr,
		grNone,
		edQrBox,
		grQrBox,
		tmPage1,
		tmPage1QrBox,
	};
	return cached;
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
		it("renders a QR of the declared edge on every layout that carries one", () => {
			const { edQrBox, grQrBox, tmPage1QrBox } = measure();
			// The control the height assertions rest on. A QR that stopped
			// rendering makes every ceiling below trivially true, and reads as the
			// roomiest possible layout — the same failure shape as the empty
			// document beside the page counts.
			//
			// Measured through a real layout engine, not off the `size` prop: this
			// is the only place that can say the square the browser BOXES is the
			// one the constant asked for.
			for (const box of [edQrBox, grQrBox, tmPage1QrBox]) {
				expect(box).toBeGreaterThanOrEqual(FOOTER_QR_PX);
			}
		});

		it("keeps the editorial agenda on ONE sheet", () => {
			const { edQr } = measure();
			// The regression #717 could have shipped. At 56px in the footer as
			// #510 built it this measured 1469px against FLOW_HEIGHT's 1464 and
			// the agenda gained a sheet, with every other gate green.
			//
			// The floor is not decorative either: a sheet SHORTER than the page
			// needs no scale at all, so it would clear the ceiling while proving
			// nothing about the squeeze band this agenda actually lives in.
			expect(edQr).toBeGreaterThan(PAGE_H);
			expect(edQr).toBeLessThan(FLOW_HEIGHT);
		});

		it("keeps the grid agenda — the default layout — on ONE sheet, with a line to spare", () => {
			const { grQr } = measure();
			// Measured 1430px against 1464. The 16px of demanded slack is roughly
			// one wrapped line of the cross-platform font variance described at the
			// top of this file, so this is "still one sheet on a machine that wraps
			// differently", not "still one sheet here".
			//
			// Grid is the layout with the least to give: it hand-rolls its own
			// officer footer, so unlike `DarkFooter` there is no disclaimer for the
			// code to sit beside and ride for free — the full square lands on the
			// sheet. Raising `FOOTER_QR_PX` fails HERE first.
			expect(grQr).toBeGreaterThan(PAGE_H);
			expect(FLOW_HEIGHT - grQr).toBeGreaterThan(16);
		});

		it("costs the shared footer almost nothing, which is what pays for the size", () => {
			const { edQr, edNone, grQr, grNone } = measure();
			// The structural claim #717 rests on. The QR is a flex sibling of the
			// ENTIRE footer stack — the left/right line and the two-line disclaimer
			// both — so a square up to about 41px is free and 56 costs 15.
			//
			// Put it back inside the left/right row, where #510 had it, and this
			// delta becomes the square's full height: 41px, which is what takes
			// editorial over the cliff. So this is the assertion that fails if a
			// future edit "simplifies" the footer back — and it catches an
			// oversized code too, which is not double-coverage of the ceilings
			// above but a different question: those ask whether THIS agenda still
			// fits, this one asks whether the footer is still cheap, which is what
			// decides whether a slightly longer agenda does.
			//
			// An absolute pixel ceiling rather than one stated against
			// `FOOTER_QR_PX`, which would move with the very number it constrains.
			// Verified by mutation: at 80 this reads 39.
			expect(edQr - edNone).toBeLessThanOrEqual(24);
			// …and the same square on grid, which has no such stack to hide in, is
			// the contrast that makes the line above a measurement rather than a
			// coincidence.
			expect(grQr - grNone).toBeGreaterThan(edQr - edNone);
		});

		it("still prints the editorial body text large enough to read", () => {
			const { edQr } = measure();
			// `print-density.test.tsx` holds this exact floor, on this exact
			// agenda, and cannot see this: its fixtures pass no `ballotUrl`, so it
			// measures a sheet with no QR on it. Measured 6.300pt here against
			// 6.366pt for the QR-less sheet that suite reports — and against
			// 6.291pt for what shipped before #717, so the bigger code is also a
			// slightly MORE legible agenda, not a trade.
			const printed = pxToPt(
				RUN_NARRATIVE_TYPE.sm.detail * Math.min(1, (PAGE_H - 2) / edQr),
			);
			expect(printed).toBeGreaterThanOrEqual(EDITORIAL_MIN_PRINTED_PT);
		});

		it("prints the timing layout's page-1 code at full size", () => {
			const { tmPage1 } = measure();
			// #717's other half. `timing` is the only two-sheet layout, and its
			// page 1 never received `ballotUrl` at all — a club printing it
			// double-sided handed out a front side with no way to vote.
			//
			// That sheet is the one place in the app where the code prints at its
			// declared edge: under PAGE_H there is no transform, so no scale. The
			// other three surfaces print it at `FOOTER_QR_PX` times their sheet's
			// scale, which is why the number in `print-theme.tsx` is a floor on
			// legibility rather than a promise of millimetres.
			expect(tmPage1).toBeGreaterThan(300); // a real sheet, not an empty one
			expect(tmPage1).toBeLessThan(PAGE_H);
		});
	},
);
