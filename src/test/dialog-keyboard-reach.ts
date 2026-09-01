/**
 * Lay a dialog out in a real browser with the visual viewport shrunk, and
 * report whether its controls are reachable.
 *
 * ## Why a browser
 *
 * Same reason as `pinned-column-scroll.ts` beside it: jsdom performs no layout
 * and loads no stylesheet, so a rendered `DialogContent` reports the same
 * (zero) geometry whether the fix is present or not. The defect only exists
 * inside a layout engine.
 *
 * ## How the keyboard is simulated, and why that is honest
 *
 * There is no way to raise a soft keyboard in headless Chrome. But the keyboard
 * is not what the fix reads — `#/lib/dialog-viewport` reads `visualViewport`
 * and copies it into two custom properties, and the CSS reads only those. So
 * this harness writes the properties the same way `writeViewportBox` does, with
 * the box a keyboard would leave, and measures what CSS then does.
 *
 * That splits #619's fix in two, and each half has its own gate:
 *
 * - the JS half (are the properties written, from the right events, and torn
 *   down at the right time) is `src/lib/dialog-viewport.test.ts`, in jsdom;
 * - the CSS half (given that box, is every control inside it) is here.
 *
 * The seam between them is the PROPERTY NAMES, and they are imported from the
 * same module the component imports, so a rename cannot leave the two halves
 * agreeing with each other and disagreeing with the shipped class string —
 * that combination fails here, loudly, because `var()` falls back to `100svh`
 * and the dialog stops fitting.
 *
 * ## What it does not prove
 *
 * The class strings come out of `dialog.tsx`, but the markup between them is
 * synthetic: mounting the real identity dialog needs a router context, a
 * QueryClientProvider and a mocked `#/db`. So this proves the class
 * COMBINATION lays out reachably against a shrunk viewport. It cannot see a
 * future child that breaks the dialog from the inside. Fonts do not load
 * (`MAP * ~NOTFOUND`), so heights are the fallback face's — reachability is a
 * yes/no about the layout algorithm rather than a pixel measurement, so the
 * substitution does not change an answer.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DIALOG_VIEWPORT_HEIGHT,
	DIALOG_VIEWPORT_TOP,
	type ViewportBox,
} from "#/lib/dialog-viewport";
import { findChrome } from "./print-page-count";

/**
 * The box a soft keyboard leaves behind, in layout-viewport coordinates.
 *
 * Aliased to the module's own `ViewportBox` rather than redeclared: this
 * harness stands in for the real `visualViewport`, so if the shape the
 * component reads ever changes, the fixture must stop compiling rather than
 * keep publishing a box that no longer matches.
 */
export type VisualBox = ViewportBox;

export type DialogProbe = {
	/**
	 * The REAL layout-viewport height, which is not `--window-size`.
	 *
	 * Chrome's bare `--headless` is NEW headless on any current build, and it
	 * opens a real window whose chrome eats into the viewport: CI measured 417px
	 * of viewport from `--window-size=375,560`. `chrome-headless-shell` is OLD
	 * headless and reports the full 560. So a test that asserts against the
	 * number it PASSED to `--window-size` silently encodes which binary ran it —
	 * which is how this suite passed locally and failed in CI by exactly the
	 * 143px difference. Assert against this instead.
	 */
	viewportHeight: number;
	/** Shell edges, relative to the layout viewport. */
	shellTop: number;
	shellBottom: number;
	shellHeight: number;
	/** Computed values, so a failure reports the cascade instead of a guess. */
	computedTop: string;
	computedMaxHeight: string;
	/** The properties read back off `<html>` — proves they were published. */
	publishedHeight: string;
	publishedTop: string;
	/** Natural content height of the scrolling body. */
	contentHeight: number;
	/** Does the scrolling body have anything to scroll at this box? */
	bodyOverflows: boolean;
	/** How far the body actually moved when driven to the bottom. */
	scrolledBy: number;
	/**
	 * With the body scrolled to the bottom, is the LAST control inside the
	 * visible band? This is the acceptance criterion on #619, stated directly.
	 */
	tailInsideVisibleBand: boolean;
	/** Is the close button still inside the band at that point (#627)? */
	closeInsideVisibleBand: boolean;
	/**
	 * Does scrolling the DOCUMENT ever bring the tail into the band? The control
	 * that makes the bug a bug: the shell is `fixed`, so "just scroll the page"
	 * is not an escape hatch and the answer must be no.
	 */
	tailReachableByPageScroll: boolean;
};

/**
 * Render `bodyHtml` against `css` at `viewport`, publish `box` as the visual
 * viewport, and probe the dialog.
 *
 * Results come back through `document.title`, the channel `--dump-dom` leaves
 * open — encoded as `key=value;` pairs so nothing needs HTML unescaping, the
 * same shape `probeColumn` uses.
 */
export function probeDialog(opts: {
	bodyHtml: string;
	css: string;
	shellSelector: string;
	bodySelector: string;
	tailSelector: string;
	closeSelector: string;
	viewport: { width: number; height: number };
	/**
	 * The box PUBLISHED to CSS. Omit to leave the properties unset — that is the
	 * pre-fix control, where the class string's `100svh` fallback applies.
	 */
	box?: VisualBox;
	/**
	 * The box JUDGED against — what the user can actually see. Separate from
	 * `box` on purpose: the control publishes nothing and is still measured
	 * against the keyboard's band, because "the dialog fits the layout viewport"
	 * is precisely the false reassurance #619 is about.
	 */
	band: VisualBox;
}): DialogProbe {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");

	// Written exactly as `writeViewportBox` writes it, including the units. The
	// names are imported rather than spelled, so this cannot drift from the
	// module under test.
	const publish = opts.box
		? `document.documentElement.style.setProperty(${JSON.stringify(
				DIALOG_VIEWPORT_HEIGHT,
			)}, ${JSON.stringify(`${opts.box.height}px`)});
			document.documentElement.style.setProperty(${JSON.stringify(
				DIALOG_VIEWPORT_TOP,
			)}, ${JSON.stringify(`${opts.box.offsetTop}px`)});`
		: "";

	const bandTop = opts.band.offsetTop;
	const bandBottom = opts.band.offsetTop + opts.band.height;

	const probe = `<script>
	(function () {
		function fail(why) { document.title = "ERROR:" + why; }
		${publish}
		var shell = document.querySelector(${JSON.stringify(opts.shellSelector)});
		var body = document.querySelector(${JSON.stringify(opts.bodySelector)});
		var tail = document.querySelector(${JSON.stringify(opts.tailSelector)});
		var close = document.querySelector(${JSON.stringify(opts.closeSelector)});
		if (!shell) return fail("no shell");
		if (!body) return fail("no body");
		if (!tail) return fail("no tail");
		if (!close) return fail("no close");
		var bandTop = ${bandTop}, bandBottom = ${bandBottom};
		function inBand(el) {
			var r = el.getBoundingClientRect();
			return r.height > 0 && r.top >= bandTop && r.bottom <= bandBottom;
		}
		var shellRect = shell.getBoundingClientRect();
		var shellStyle = getComputedStyle(shell);
		var rootStyle = document.documentElement.style;
		var out = {
			viewportHeight: window.innerHeight,
			shellTop: Math.round(shellRect.top),
			shellBottom: Math.round(shellRect.bottom),
			shellHeight: Math.round(shellRect.height),
			computedTop: shellStyle.top,
			computedMaxHeight: shellStyle.maxHeight,
			publishedHeight: rootStyle.getPropertyValue(${JSON.stringify(
				DIALOG_VIEWPORT_HEIGHT,
			)}) || "unset",
			publishedTop: rootStyle.getPropertyValue(${JSON.stringify(
				DIALOG_VIEWPORT_TOP,
			)}) || "unset",
			contentHeight: body.scrollHeight,
			bodyOverflows: body.scrollHeight > body.clientHeight ? 1 : 0
		};
		body.scrollTop = body.scrollHeight;
		out.scrolledBy = Math.round(body.scrollTop);
		out.tailInsideVisibleBand = inBand(tail) ? 1 : 0;
		out.closeInsideVisibleBand = inBand(close) ? 1 : 0;
		body.scrollTop = 0;
		var reachable = 0;
		for (var y = 0; y <= document.documentElement.scrollHeight; y += 25) {
			window.scrollTo(0, y);
			if (inBand(tail)) { reachable = 1; break; }
		}
		window.scrollTo(0, 0);
		out.tailReachableByPageScroll = reachable;
		document.title = Object.keys(out).map(function (k) {
			return k + "=" + out[k];
		}).join(";");
	})();
	</script>`;

	const dir = mkdtempSync(join(tmpdir(), "dialog-keyboard-"));
	try {
		writeFileSync(join(dir, "app.css"), opts.css, "utf8");
		writeFileSync(
			join(dir, "page.html"),
			`<!doctype html><html><head><meta charset="utf-8">` +
				`<link rel="stylesheet" href="./app.css"></head><body>` +
				`${opts.bodyHtml}${probe}</body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				// Profile isolation — vitest runs test FILES in parallel and this
				// harness spawns alongside the print suites and the pinned-column
				// one; without it they contend for the DEFAULT profile's lock, and a
				// `CHROME_PATH` aimed at a real Chrome writes into the developer's
				// own profile.
				`--user-data-dir=${dir}`,
				`--window-size=${opts.viewport.width},${opts.viewport.height}`,
				"--virtual-time-budget=3000",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			// A hung browser cannot be interrupted from a SYNC call, so vitest's
			// per-test ceiling never fires and the run wedges rather than failing.
			// Same guard, and same 30s hang-detector budget, as `probeColumn`.
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
			},
		);
		const title = /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? "";
		if (title.startsWith("ERROR:")) throw new Error(`probe: ${title.slice(6)}`);
		// A missing title means the script never ran — an empty page, a CSS 404, a
		// Chrome that exited early. Every flag below would then default to "not
		// reachable", which reads exactly like the bug this measures.
		if (!title.includes("shellHeight=")) {
			throw new Error(`probe produced no measurement (title: ${title || "∅"})`);
		}
		const kv = new Map(
			title.split(";").map((p) => p.split("=") as [string, string]),
		);
		const num = (k: string) => Number(kv.get(k) ?? "NaN");
		const flag = (k: string) => kv.get(k) === "1";
		return {
			viewportHeight: num("viewportHeight"),
			shellTop: num("shellTop"),
			shellBottom: num("shellBottom"),
			shellHeight: num("shellHeight"),
			computedTop: kv.get("computedTop") ?? "",
			computedMaxHeight: kv.get("computedMaxHeight") ?? "",
			publishedHeight: kv.get("publishedHeight") ?? "",
			publishedTop: kv.get("publishedTop") ?? "",
			contentHeight: num("contentHeight"),
			bodyOverflows: flag("bodyOverflows"),
			scrolledBy: num("scrolledBy"),
			tailInsideVisibleBand: flag("tailInsideVisibleBand"),
			closeInsideVisibleBand: flag("closeInsideVisibleBand"),
			tailReachableByPageScroll: flag("tailReachableByPageScroll"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
