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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	printableDocument,
} from "#/test/print-page-count";
import { type AgendaLayout, MeetingAgendaPrint } from "./meeting-agenda-print";
import {
	PRINT_PAGE_CSS,
	pageBox,
	printPageCss,
	SCREEN_FIT_CSS,
} from "./print-theme";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

const hasChrome = findChrome() !== null;

const PHONE_W = 375;
const DESKTOP_W = 1280;
const FRAME_H = 812;

const LAYOUTS: readonly AgendaLayout[] = [
	"editorial",
	"grid",
	"timing",
	"spacious",
];

type Surface = AgendaLayout | "poster";

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
	sheets: Sheet[];
};

type Case = { id: string; surface: Surface; fixed: boolean; width: number };

const CASES: Case[] = (["poster", ...LAYOUTS] as Surface[]).flatMap((surface) =>
	[PHONE_W, DESKTOP_W].flatMap((width) =>
		[true, false].map((fixed) => ({
			id: `${surface}-${width}-${fixed ? "fixed" : "control"}`,
			surface,
			fixed,
			width,
		})),
	),
);

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
				left: r.left, right: r.right, width: r.width, height: r.height,
				natural: inner ? inner.scrollHeight : -1
			};
		}
	);
	parent.postMessage({
		id: location.hash.slice(1),
		frame: { clientWidth: d.clientWidth, scrollWidth: d.scrollWidth, sheets: sheets }
	}, "*");
});
</script>`;

/** Every case from ONE Chrome launch — a launch is the harness's whole cost. */
function measureAll(cases: readonly Case[]): Map<string, Frame> {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome");
	const dir = mkdtempSync(join(tmpdir(), "print-screen-fit-"));
	try {
		const frames = cases
			.map((c) => {
				const file = `${c.id}.html`;
				writeFileSync(
					join(dir, file),
					surfaceDocument(c.surface, c.fixed).replace(
						"</body>",
						`${FRAME_PROBE}</body>`,
					),
					"utf8",
				);
				return `<iframe src="${file}#${c.id}" style="display:block;border:0;width:${c.width}px;height:${FRAME_H}px"></iframe>`;
			})
			.join("");
		const outer = `<!doctype html><html><head><title>pending</title></head><body style="margin:0">
<pre id="out"></pre>${frames}
<script>
var got = {}, want = ${cases.length};
addEventListener("message", function (e) {
	got[e.data.id] = e.data.frame;
	if (Object.keys(got).length === want) {
		document.getElementById("out").textContent = JSON.stringify(got);
		document.title = "done";
	}
});
</script></body></html>`;
		const outerPath = join(dir, "outer.html");
		writeFileSync(outerPath, outer, "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--window-size=1400,900",
				"--virtual-time-budget=5000",
				"--dump-dom",
				`file://${outerPath}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 20_000, env: CHROME_ENV },
		);
		const title = dom.match(/<title>([^<]*)<\/title>/)?.[1];
		const json = dom.match(/<pre id="out">([^<]*)<\/pre>/)?.[1];
		if (title !== "done" || !json) {
			throw new Error(
				`Not every frame reported back; Chrome's title was "${title}".`,
			);
		}
		const parsed = JSON.parse(
			json.replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
		) as Record<string, Frame>;
		return new Map(Object.entries(parsed));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

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
		const frame = (surface: Surface, width: number, fixed: boolean): Frame => {
			cache ??= measureAll(CASES);
			const id = `${surface}-${width}-${fixed ? "fixed" : "control"}`;
			const f = cache.get(id);
			if (!f) throw new Error(`no measurement for ${id}`);
			if (f.sheets.length === 0) throw new Error(`${id} rendered no sheet`);
			return f;
		};

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
		)("%s: desktop geometry is identical to the pre-fix control", (surface) => {
			expect(frame(surface, DESKTOP_W, true)).toEqual(
				frame(surface, DESKTOP_W, false),
			);
		});
	},
);
