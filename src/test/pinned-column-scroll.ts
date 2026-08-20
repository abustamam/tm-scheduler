/**
 * Lay a pinned column out in a real browser and report whether its tail is
 * reachable.
 *
 * ## Why this exists
 *
 * This repo has shipped the same defect twice, on two different surfaces, and
 * both times every gate was green. A column that is `position: sticky` with a
 * height ceiling cannot grow, and being pinned means the DOCUMENT scroll never
 * reveals what spills out of it — so without its own scroller the overflow is
 * reachable by nothing at all. The app shell's nav did it at ~28 items (the
 * "Me" group, "Platform" and the sign-out footer, gone); the meeting page's
 * attendance rail did it at ~10 rows of a 40-member roster (v1.19.0.0).
 *
 * jsdom performs no layout and loads no stylesheet, so a rendered component
 * reports the same (zero) geometry whether the fix is present or not, and
 * typecheck and lint have no view of Tailwind semantics. The existing source
 * greps pin the MECHANISM — that a class string is present on an element — and
 * `attendance-panel-wiring.guard.test.ts` says so in as many words: "this pins
 * the mechanism and never the geometry ... only a browser can see that". This
 * is that browser.
 *
 * ## What it does and does not prove
 *
 * The class strings come out of the real source files, so deleting the scroller
 * fails these tests. The markup BETWEEN them is synthetic — a plausible band of
 * rows, not the real `SidebarInner` or `MeetingAttendancePanel` subtree, both of
 * which need a router context and a mocked `#/db` to render at all. So this
 * proves the class COMBINATION lays out reachably at a given viewport. It
 * cannot see a future child that breaks the column from the inside (an element
 * with its own `min-height`, say). Pair it with the source greps, which pin
 * WHICH element and WHICH file the classes live on — geometry cannot see that
 * either.
 *
 * Fonts do not load here (`MAP * ~NOTFOUND`, as in `print-page-count.ts`), so
 * row heights are the fallback face's. Reachability is a yes/no about the
 * layout algorithm, not a pixel measurement, so that substitution does not
 * change an answer the way it would change a printed page count.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compile } from "tailwindcss";
import { findChrome } from "./print-page-count";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../..");

/**
 * Compile the app's OWN stylesheet, so the utilities under test resolve through
 * the project's theme rather than a stock Tailwind this app never serves.
 * Cached — the compile is the slow part and the input never changes within a
 * run.
 *
 * `@plugin '@tailwindcss/typography'` is dropped: it contributes `prose`
 * classes only, nothing here renders one, and loading it would need a JS module
 * resolver this harness has no other reason to grow.
 */
let compiler: Awaited<ReturnType<typeof compile>> | null = null;

export async function buildAppCss(candidates: string[]): Promise<string> {
	if (!compiler) {
		const css = readFileSync(resolve(REPO, "src/styles.css"), "utf8").replace(
			/^@plugin .*$/gm,
			"",
		);
		compiler = await compile(css, {
			base: resolve(REPO, "src"),
			// The Google Fonts `@import` cannot be fetched offline and carries no
			// geometry; `tw-animate-css` ships keyframes under a non-standard entry.
			// Neither can change whether a column scrolls.
			loadStylesheet: async (id: string, base: string) => {
				if (id.startsWith("http")) return { content: "", base, path: id };
				const path = id.startsWith(".")
					? resolve(base, id)
					: resolve(REPO, "node_modules", id, "index.css");
				try {
					return {
						content: readFileSync(path, "utf8"),
						base: dirname(path),
						path,
					};
				} catch {
					return { content: "", base, path: id };
				}
			},
		});
	}
	const out = compiler.build(candidates);
	// A compile that silently produced nothing would leave every fixture
	// unstyled — no `h-svh`, no cap, nothing overflowing — and a caller's
	// reachability assertions would be measuring a plain document.
	//
	// Keyed on `display: flex`, which every fixture uses and no under-test class
	// controls. Two things this got wrong first, both worth keeping: keying it on
	// `overflow-y` (the obvious choice) makes it fire during the mutation
	// controls, which deliberately remove the only overflow candidates — turning
	// a geometry failure into a harness error and hiding what the control exists
	// to show; and the build is pretty-printed rather than minified, so matching
	// the spaceless `display:flex` fired on every run.
	if (!/display:\s*flex/.test(out)) {
		throw new Error("Tailwind produced no layout utilities — bad candidates?");
	}
	return out;
}

/** Every class token in a fragment of HTML — Tailwind's candidate list. */
export function candidatesIn(html: string): string[] {
	const out = new Set<string>();
	for (const m of html.matchAll(/class="([^"]*)"/g)) {
		for (const token of m[1].split(/\s+/)) if (token) out.add(token);
	}
	return [...out];
}

export type ColumnProbe = {
	/** Computed `overflow-y` of the element expected to be the scroller. */
	overflowY: string;
	/** Does the scroller's content exceed its box at this viewport? */
	overflows: boolean;
	/** How far the scroller actually moved when driven to the bottom. */
	scrolledBy: number;
	/** Is the LAST item in view once the scroller is at the bottom? */
	tailVisibleAfterScroll: boolean;
	/**
	 * Is the pinned chrome (brand, footer, card header) STILL in view at that
	 * point? A column that scrolls its own header away is reachable but has lost
	 * the thing the reader was orienting by.
	 */
	chromeVisibleAfterScroll: boolean;
	/**
	 * Does scrolling the DOCUMENT ever bring the tail into view? This is the
	 * control that makes the bug a bug: for a sticky column the answer is no, so
	 * "the user can just scroll the page" is not an escape hatch.
	 */
	tailReachableByPageScroll: boolean;
};

/**
 * Render `bodyHtml` against the compiled app CSS at a fixed viewport and probe
 * the column.
 *
 * Reads the result back through `document.title`, the same channel
 * `measuredHeight` uses — `--dump-dom` serializes the post-script DOM and has
 * no other return path. Encoded as `key=value;` pairs rather than JSON so that
 * nothing in the payload needs HTML unescaping.
 */
export function probeColumn(opts: {
	bodyHtml: string;
	css: string;
	scrollerSelector: string;
	tailSelector: string;
	chromeSelector: string;
	viewport: { width: number; height: number };
}): ColumnProbe {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");

	const probe = `<script>
	(function () {
		function fail(why) { document.title = "ERROR:" + why; }
		var s = document.querySelector(${JSON.stringify(opts.scrollerSelector)});
		var tail = document.querySelector(${JSON.stringify(opts.tailSelector)});
		var chrome = document.querySelector(${JSON.stringify(opts.chromeSelector)});
		if (!s) return fail("no scroller");
		if (!tail) return fail("no tail");
		if (!chrome) return fail("no chrome");
		var vh = window.innerHeight;
		function inView(el) {
			var r = el.getBoundingClientRect();
			return r.top >= 0 && r.bottom <= vh && r.height > 0;
		}
		var out = {
			overflowY: getComputedStyle(s).overflowY,
			overflows: s.scrollHeight > s.clientHeight ? 1 : 0
		};
		s.scrollTop = s.scrollHeight;
		out.scrolledBy = s.scrollTop;
		out.tailVisibleAfterScroll = inView(tail) ? 1 : 0;
		out.chromeVisibleAfterScroll = inView(chrome) ? 1 : 0;
		s.scrollTop = 0;
		var reachable = 0;
		for (var y = 0; y <= document.documentElement.scrollHeight; y += 50) {
			window.scrollTo(0, y);
			if (inView(tail)) { reachable = 1; break; }
		}
		window.scrollTo(0, 0);
		out.tailReachableByPageScroll = reachable;
		document.title = Object.keys(out).map(function (k) {
			return k + "=" + out[k];
		}).join(";");
	})();
	</script>`;

	const dir = mkdtempSync(join(tmpdir(), "pinned-column-"));
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
				`--window-size=${opts.viewport.width},${opts.viewport.height}`,
				"--virtual-time-budget=3000",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const title = /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? "";
		if (title.startsWith("ERROR:")) throw new Error(`probe: ${title.slice(6)}`);
		// A missing title means the script never ran — an empty page, a CSS 404,
		// a Chrome that exited early. Every field below would then default to
		// "not reachable", which reads exactly like the bug this measures.
		if (!title.includes("overflowY=")) {
			throw new Error(`probe produced no measurement (title: ${title || "∅"})`);
		}
		const kv = new Map(
			title.split(";").map((p) => p.split("=") as [string, string]),
		);
		const flag = (k: string) => kv.get(k) === "1";
		return {
			overflowY: kv.get("overflowY") ?? "",
			overflows: flag("overflows"),
			scrolledBy: Number(kv.get("scrolledBy") ?? "0"),
			tailVisibleAfterScroll: flag("tailVisibleAfterScroll"),
			chromeVisibleAfterScroll: flag("chromeVisibleAfterScroll"),
			tailReachableByPageScroll: flag("tailReachableByPageScroll"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
