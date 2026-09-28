/**
 * The printable agenda fits a phone's screen (#964).
 *
 * A sheet is a fixed 816px box because that is what prints. Opened on a 375px
 * phone it was wider than the screen: the two-page layouts (timing, spacious)
 * centre their sheets in a flex column, so both edges spilled out and the left
 * one landed at a NEGATIVE x that no scrolling can reach, and the one-page
 * layouts (editorial, grid) lost their right edge to `body { overflow-x:
 * hidden }`. `SCREEN_FIT_CSS` (print-theme.tsx) now scales the sheet down on
 * screen only.
 *
 * Nothing in-process can see any of this — jsdom does no layout — so this lays
 * the four layouts out in headless Chrome. Headless Chrome will not size a
 * WINDOW below 500px, so each page is loaded into a 375px-wide IFRAME, which
 * gives it a genuine 375px viewport (`100vw`, media queries and all). The frame
 * also draws a classic 15px scrollbar, which a phone does not, so the edge
 * assertions are measured against `clientWidth` — stricter than a phone.
 *
 * Four things pinned, each with the mutation it catches:
 *
 *  · At 375px every sheet's left and right edges are inside the viewport and
 *    nothing scrolls sideways — beside a pre-fix CONTROL (the same markup with
 *    the screen-fit rule removed) that must reproduce the clipping, so the
 *    assertions are known to be able to fail.
 *  · The sheet keeps its proportions (a letter page, not a squashed one).
 *  · The natural height `FitPage` measures is the same at 375px as on a
 *    desktop. `FitPage` measures ON SCREEN and prints at the scale it derives,
 *    so a phone must measure what a laptop measures. `zoom` fails this (the
 *    text reflows: editorial measured 1282px zoomed vs 1256px), which is why
 *    the rule is a `transform`.
 *  · At a desktop width the geometry is identical to the control's, to the
 *    pixel: desktop rendering is unchanged.
 *
 * The landscape Word of the Day poster rides the same rule and is included so
 * the per-sheet width variable is pinned: a 1056px sheet fitted as if it were
 * 816px still overflows a phone. Its pre-fix failure is a different shape — its
 * wrapper is a flex ROW, so the sheet is squeezed to the screen's width and its
 * own `overflow: hidden` cuts the right of the page off — which is why the
 * control also counts a sheet narrower than its page's proportions as clipped.
 *
 * Print is not measured here: the rule is `@media screen`, and the print gates
 * (`print-page-count`, `print-density`, `ballot-qr-print-fit`) run unchanged.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FrameCase, measureInFrames } from "#/test/iframe-batch";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	printableDocument,
} from "#/test/print-page-count";
import { type AgendaLayout, MeetingAgendaPrint } from "./meeting-agenda-print";
import {
	FitPage,
	PAGE_W,
	PRINT_PAGE_CSS,
	pageBox,
	printPageCss,
	SCREEN_FIT_CSS,
	SCREEN_FIT_GUTTER_PX,
	SHEET_H_VAR,
} from "./print-theme";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

const hasChrome = findChrome() !== null;

const PHONE_W = 375;
/** Portrait iPad widths either side of `100vw - 2 * gutter = PAGE_W`: the sheet
 *  already fitted both before #964, so both must render exactly as before. */
const TABLET_WS = [820, 848] as const;
const DESKTOP_W = 1280;
const WIDTHS = [PHONE_W, ...TABLET_WS, DESKTOP_W];
const FRAME_H = 812;

const LAYOUTS: readonly AgendaLayout[] = [
	"editorial",
	"grid",
	"timing",
	"spacious",
];

type Surface = AgendaLayout | "poster";

/** `.pgwrap`'s screen padding, the only chrome below the last sheet. */
const PGWRAP_PAD_PX = 28;
/** What sits below the last sheet on each surface: TwoPage and the poster
 *  route wrap theirs in `.pgwrap`; editorial and grid have no wrapper. */
function trailingChrome(surface: Surface): number {
	return surface === "editorial" || surface === "grid" ? 0 : PGWRAP_PAD_PX;
}

/** Width over height of the sheet a surface prints: the poster is landscape. */
function sheetAspect(surface: Surface): number {
	const { width, height } = pageBox(
		surface === "poster" ? "landscape" : "portrait",
	);
	return width / height;
}

function stripFit(css: string): string {
	if (!css.includes(SCREEN_FIT_CSS)) {
		throw new Error("SCREEN_FIT_CSS is not in the stylesheet any more");
	}
	return css.replace(SCREEN_FIT_CSS, "");
}

function surfaceDocument(surface: Surface, fixed: boolean): string {
	if (surface === "poster") {
		const css = printPageCss("landscape");
		// The word route's own wrapper, so the flex centring is the real one.
		const body = renderToStaticMarkup(
			<div
				className="pgwrap"
				style={{ display: "flex", justifyContent: "center" }}
			>
				<WordOfTheDayPoster
					word="Ephemeral"
					definition="Lasting for a very short time; fleeting."
					example="The applause was ephemeral, but the lesson stayed."
					clubName="MCF Toastmasters"
					dateLong="Friday, July 31, 2026"
					logoUrl={null}
				/>
			</div>,
		);
		return printableDocument(fixed ? css : stripFit(css), body);
	}
	const body = renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={surface}
			header={MCF_HEADER}
			roles={MCF_ROLES}
			officers={MCF_OFFICERS}
			explainers={MCF_EXPLAINERS}
			rows={MCF_ROWS}
		/>,
	);
	return printableDocument(
		fixed ? PRINT_PAGE_CSS : stripFit(PRINT_PAGE_CSS),
		body,
	);
}

type Sheet = {
	top: number;
	left: number;
	right: number;
	width: number;
	height: number;
	/** `[data-fit-inner]`'s scrollHeight: the number `FitPage` measures. */
	natural: number;
};

type Frame = {
	clientWidth: number;
	scrollWidth: number;
	scrollHeight: number;
	clientHeight: number;
	sheets: Sheet[];
};

type Case = FrameCase;

const caseId = (surface: Surface, width: number, fixed: boolean) =>
	`${surface}-${width}-${fixed ? "fixed" : "control"}`;

/** Natural height of the long sheet in the flow fixture — past the flow cliff. */
const FLOW_CONTENT_PX = 2400;

/**
 * A sheet in `FitPage`'s FLOW state (a 40-58-row speech contest), which static
 * markup cannot reach: the decision is a `useEffect`. So the page is put in the
 * state the effect leaves it in — height and clip dropped, the inner floor
 * cleared — and `--sheet-h` is set either to the measured height (what
 * `FitPage` now does; `print-screen-fit.test.tsx` pins that in jsdom) or left
 * at the page box (what it did first, which left a blank band on a phone).
 */
function flowDocument(sheetHTracksContent: boolean): string {
	const body = renderToStaticMarkup(
		<FitPage>
			<div style={{ height: FLOW_CONTENT_PX, background: "#eee" }} />
		</FitPage>,
	);
	const prep = `<script>
	(function () {
		var p = document.querySelector(".agenda-page");
		var inner = p.querySelector("[data-fit-inner]");
		p.style.height = ""; p.style.overflow = ""; inner.style.minHeight = "";
		${sheetHTracksContent ? `p.style.setProperty(${JSON.stringify(SHEET_H_VAR)}, inner.scrollHeight + "px");` : ""}
	})();
	</script>`;
	return printableDocument(PRINT_PAGE_CSS, body + prep);
}

const CASES: Case[] = [
	...(["poster", ...LAYOUTS] as Surface[]).flatMap((surface) =>
		WIDTHS.flatMap((width) =>
			[true, false].map((fixed) => ({
				id: caseId(surface, width, fixed),
				html: surfaceDocument(surface, fixed),
				width,
			})),
		),
	),
	{ id: "flow-tracked", html: flowDocument(true), width: PHONE_W },
	{ id: "flow-stale", html: flowDocument(false), width: PHONE_W },
];

/** Inside each frame: report the viewport and every sheet to the parent. */
const FRAME_PROBE = `<script>
addEventListener("load", function () {
	var d = document.documentElement;
	var sheets = Array.prototype.map.call(
		document.querySelectorAll(".agenda-page"),
		function (p) {
			var r = p.getBoundingClientRect();
			var inner = p.querySelector("[data-fit-inner]");
			return {
				top: r.top, left: r.left, right: r.right, width: r.width, height: r.height,
				natural: inner ? inner.scrollHeight : -1
			};
		}
	);
	parent.postMessage({
		id: location.hash.slice(1),
		frame: {
			clientWidth: d.clientWidth, scrollWidth: d.scrollWidth,
			scrollHeight: d.scrollHeight,
			clientHeight: d.clientHeight, sheets: sheets
		}
	}, "*");
});
</script>`;

/** Every case from ONE Chrome launch — a launch is the harness's whole cost. */
const measureAll = (cases: readonly Case[]) =>
	measureInFrames<Frame>(cases, { probe: FRAME_PROBE, frameHeight: FRAME_H });

describe("print screen-fit harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the phone-width print geometry would skip and " +
				"the suite would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the printable agenda fits a phone's screen (#964)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		// Lazily, once: a describe body runs at collection time even when skipped.
		let cache: Map<string, Frame> | undefined;
		const byId = (id: string): Frame => {
			cache ??= measureAll(CASES);
			const f = cache.get(id);
			if (!f) throw new Error(`no measurement for ${id}`);
			if (f.sheets.length === 0) throw new Error(`${id} rendered no sheet`);
			return f;
		};
		const frame = (surface: Surface, width: number, fixed: boolean) =>
			byId(caseId(surface, width, fixed));
		/** Where the last sheet's VISIBLE (scaled) box ends, in document px. */
		const sheetBottom = (f: Frame) =>
			Math.max(...f.sheets.map((s) => s.top + s.height));
		/**
		 * Scrollable document past what the page legitimately needs: the scaled
		 * sheet plus the chrome below it, or one screenful, whichever is taller
		 * (a document is never shorter than its viewport).
		 */
		const blankBand = (f: Frame, chrome: number) =>
			f.scrollHeight - Math.max(f.clientHeight, sheetBottom(f) + chrome);

		const SURFACES: readonly Surface[] = [...LAYOUTS, "poster"];

		it.each(
			SURFACES,
		)("%s: the pre-fix control is clipped at 375px", (surface) => {
			const f = frame(surface, PHONE_W, false);
			const aspect = sheetAspect(surface);
			const clipped = f.sheets.some(
				(s) =>
					s.left < 0 ||
					s.right > f.clientWidth ||
					// The poster's wrapper is a flex ROW, so instead of spilling out
					// its sheet is squeezed to the screen's width and `overflow:
					// hidden` cuts the right-hand part of the page off inside it.
					s.width / s.height < aspect - 0.01,
			);
			expect(clipped, JSON.stringify(f)).toBe(true);
		});

		it.each(
			SURFACES,
		)("%s: every sheet is inside a 375px viewport, with no sideways scroll", (surface) => {
			const f = frame(surface, PHONE_W, true);
			for (const s of f.sheets) {
				expect(s.left, JSON.stringify(f)).toBeGreaterThanOrEqual(0);
				expect(s.right, JSON.stringify(f)).toBeLessThanOrEqual(f.clientWidth);
			}
			expect(f.scrollWidth).toBeLessThanOrEqual(f.clientWidth);
		});

		it.each(
			SURFACES,
		)("%s: the sheet keeps a letter page's proportions", (surface) => {
			// Static markup never runs FitPage's effect, so no sheet flows here:
			// every one is a fixed page box.
			for (const s of frame(surface, PHONE_W, true).sheets) {
				expect(s.width / s.height).toBeCloseTo(sheetAspect(surface), 2);
			}
		});

		it.each(
			SURFACES,
		)("%s: FitPage's measurement is the same on a phone as on a desktop", (surface) => {
			const phone = frame(surface, PHONE_W, true).sheets.map((s) => s.natural);
			const desk = frame(surface, DESKTOP_W, true).sheets.map((s) => s.natural);
			expect(phone).toEqual(desk);
		});

		it.each(
			SURFACES,
		)("%s: at 375px the document ends at the scaled sheet, with no blank band", (surface) => {
			// A transform leaves the layout box full height; without the negative
			// bottom margin the page scrolls through ~(1 - fit) x 1056px of nothing
			// below every sheet.
			// Measured before the inline-block fix: the negative margin collapsed
			// out of the editorial sheet's ancestors and left a 612px band.
			const f = frame(surface, PHONE_W, true);
			expect(f.scrollHeight).toBeGreaterThanOrEqual(sheetBottom(f));
			expect(
				blankBand(f, trailingChrome(surface)),
				JSON.stringify(f),
			).toBeLessThanOrEqual(1);
		});

		it("a FLOWING sheet ends where its scaled content does, at 375px", () => {
			const f = byId("flow-tracked");
			const [sheet] = f.sheets;
			// It really is a flowing sheet, shrunk, and taller than the screen — so
			// the band check below is not satisfied by the viewport floor.
			const scaledW = PHONE_W - 2 * SCREEN_FIT_GUTTER_PX;
			expect(sheet?.width).toBeCloseTo(scaledW, 0);
			expect(sheet?.height).toBeCloseTo(
				(scaledW * FLOW_CONTENT_PX) / PAGE_W,
				0,
			);
			expect(sheetBottom(f)).toBeGreaterThan(f.clientHeight);
			expect(f.scrollHeight).toBeGreaterThanOrEqual(sheetBottom(f));
			expect(blankBand(f, 0), JSON.stringify(f)).toBeLessThanOrEqual(1);
		});

		it("CONTROL: a flowing sheet fitted against the page box leaves a blank band", () => {
			// --sheet-h left at 1056 gives back only (1 - fit) x 1056 of the
			// (1 - fit) x 2400 the scale took.
			const f = byId("flow-stale");
			expect(blankBand(f, 0), JSON.stringify(f)).toBeGreaterThan(500);
		});

		// Every width the sheet already fitted: 820 and 848 (portrait iPads, and
		// either side of where `100vw - 2 * gutter` reaches the page width) and a
		// desktop for the portrait layouts; only the desktop for the 1056px
		// poster, which does NOT fit 820 or 848 and is shrunk there by design.
		it.each([
			...LAYOUTS.flatMap((layout) =>
				[...TABLET_WS, DESKTOP_W].map((width) => [layout, width] as const),
			),
			["poster", DESKTOP_W] as const,
		])("%s at %ipx: geometry is identical to the pre-fix control", (surface, width) => {
			expect(frame(surface, width, true)).toEqual(frame(surface, width, false));
		});
	},
);
