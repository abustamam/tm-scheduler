/**
 * Count the pages a print surface actually renders (#502).
 *
 * Print CSS is invisible to every other gate in this repo, and that is not a
 * hypothesis. A missing `.pgwrap { padding: 0 !important }` reset put a blank
 * second page on the Word of the Day poster and survived six test files,
 * typecheck, lint, a spec review and a code-quality review (v1.3.0.0). The only
 * thing that has ever caught it is rendering the page and counting sheets,
 * which until now was done by hand, once.
 *
 * The approach is deliberately boring: render the component to static HTML,
 * inline the same stylesheet the route serves, and let headless Chrome paginate
 * it exactly as a browser printing the page would. No dev server is involved —
 * Chrome cannot render this repo's Vite dev server, because under HMR the page
 * never settles and `--dump-dom` hangs (hit for real during #490).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Binaries that can drive `--print-to-pdf`, most preferred first.
 *
 * Names only, deliberately. These resolve on Linux, where this repo is usually
 * developed, so the gates run locally there. macOS is the gap: Chrome installs
 * as an .app that puts nothing on `PATH`, so it is tempting to add
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` here. Tried,
 * reverted: that binary answers `--version` but never returns from
 * `--print-to-pdf` under the agent sandbox, so `findChrome` starts succeeding
 * and every measurement then burns its full timeout — one `bun run test` went
 * from an instant skip to 135 seconds of `ETIMEDOUT`, including the 60s
 * warm-up. A browser that is found but hangs is strictly worse than one that is
 * not found: the skip is honest and CI still fails on a missing browser (see the
 * availability `describe` in `print-page-count.test.tsx`), whereas the hang looks
 * like a broken gate. Set `CHROME_PATH` on a Mac instead (a Playwright
 * `chrome-headless-shell` works); if you do add a path here, verify a real
 * `--print-to-pdf` RETURNS first.
 */
const CHROME_BINARIES = [
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
];

/** Memoized: `findChrome` is called once per surface and the answer cannot change. */
let cachedChrome: string | null | undefined;

/**
 * The first usable Chrome — `CHROME_PATH` if it runs, else the first name on
 * `PATH` that does — or null.
 *
 * Exported so the suite can distinguish "no browser here" from "the browser
 * disagreed" — see the `print page-count harness availability` describe in
 * `print-page-count.test.tsx`, which fails rather than skips when CI has no
 * browser, so the second can never hide behind the first.
 *
 * Runs the binary rather than probing with `command -v` through a shell. That
 * proves it is both on PATH and executable in one step, and avoids passing an
 * args array alongside `shell`, which Node deprecates (DEP0190) and which
 * printed a warning above every `bun run test` in this repo.
 */
/**
 * Per-test ceiling every suite that drives this harness should use:
 * `describe(name, { timeout: CHROME_TEST_TIMEOUT_MS }, fn)`.
 *
 * `vitest.config.ts` sets 15s globally and says why — it is sized for the ~50
 * DB-backed suites contending over one Postgres, and is "a guard against a hung
 * test, not a latency budget". Neither half describes a case that SPAWNS A
 * BROWSER. Every `printedPageCount` / `measuredHeight` starts a fresh Chrome
 * with its own `--user-data-dir`; vitest runs test FILES in parallel, so the two
 * suites that use this harness spawn concurrently and slow each other down. On a
 * cold CI runner a single spawn can outlast the whole global ceiling — measured
 * at 16.5s for one measurement, and 15.7s for one page count, both after passing
 * locally in ~2.5s and on several prior CI runs.
 *
 * It lives HERE rather than in either suite because it is a property of the
 * harness, not of what any one file measures — and because fixing one file and
 * leaving the other is exactly what happened first: the density suite was given
 * its own ceiling while `print-page-count` kept the global one and failed on the
 * next run with the identical error.
 *
 * Raising the GLOBAL value would be wrong: that number protects fifty suites
 * these two have nothing in common with. `execFileSync` below keeps its own
 * 10s-per-spawn timeout, so a genuinely hung Chrome still fails fast.
 */
export const CHROME_TEST_TIMEOUT_MS = 60_000;

export function findChrome(): string | null {
	if (cachedChrome !== undefined) return cachedChrome;
	// `CHROME_PATH` first — the convention Lighthouse and chrome-launcher already
	// use, and the way out of the macOS problem the list above describes without
	// hardcoding a path that hangs. Pointing it at a working browser (a Playwright
	// `chrome-headless-shell` works, and returns in ~0.2s) is what makes this gate
	// runnable off CI. Still probed rather than trusted: an unset-but-exported or
	// stale value falls through to the names instead of disabling the gate.
	for (const bin of [process.env.CHROME_PATH, ...CHROME_BINARIES]) {
		if (!bin) continue;
		try {
			execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 10_000 });
			cachedChrome = bin;
			return bin;
		} catch {
			// not on PATH, or not runnable; try the next one
		}
	}
	cachedChrome = null;
	return null;
}

/**
 * How many pages a PDF has, read from the page tree.
 *
 * Reads `/Count` off the `/Type /Pages` root rather than counting `/Type /Page`
 * objects, because CONTENT CAN FORGE THE LATTER. Chrome writes the document
 * title into `/Info` and link hrefs into `/Annots /URI` UNCOMPRESSED, so a page
 * whose title contains the literal `/Type /Page` inflates the count: measured 4
 * on a genuinely 2-page document. Body text is safe (content streams are Flate-
 * compressed), which is exactly why the flaw would survive casual testing and
 * surface later, on the first fixture built from real content.
 *
 * The failure is not one-directional either — a spurious +1 reads as a failure
 * on the surfaces baselined at 1 page, but would MASK a real drop from 2 to 1.
 *
 * Takes the maximum across matches: a nested page tree gives intermediate nodes
 * their own `/Count`, and the root's is the total.
 */
export function countPdfPages(pdf: Buffer): number {
	const counts = [
		...pdf
			.toString("latin1")
			.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/gs),
	].map((m) => Number(m[1]));
	if (counts.length === 0) {
		throw new Error(
			"No /Type /Pages ... /Count found — the PDF is malformed, or Chrome " +
				"changed its writer. Refusing to guess a page count.",
		);
	}
	return Math.max(...counts);
}

/**
 * Wrap rendered markup in a minimal document.
 *
 * `body { margin: 0 }` is NOT cosmetic and must not be dropped. `@page` sets
 * `margin: 0` and the print surfaces are sized to exactly one letter page, so a
 * default 8px body margin pushes 1056px of content past the page box and emits a
 * blank second sheet — the v1.3.0.0 bug, reproduced by omission.
 *
 * `src/styles.css` is the source of truth for that reset in the real app; this
 * is a copy. If a body margin or padding is ever added there, this must follow,
 * or the harness measures a document the app does not serve.
 */
export function printableDocument(css: string, bodyHtml: string): string {
	return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
${css}
</style></head><body>${bodyHtml}</body></html>`;
}

/**
 * Whether the one-off Chrome warm-up below has already run this process.
 * Module-level so every consumer of `printedPageCount` gets it without having
 * to remember a `beforeAll`.
 */
let warmed = false;

/**
 * Pay Chrome's cold start ONCE, on a trivial document, outside any measured
 * call's budget.
 *
 * Why this exists. The first surface measured absorbs Chrome's first-run cost —
 * profile creation, font config, sandbox setup — which on a CI runner is ~7s,
 * against ~880ms for every surface after it. With `printedPageCount`'s 10s
 * ceiling that left ~30% headroom, and a slow runner ate it: `agenda · grid`
 * failed with `spawnSync google-chrome ETIMEDOUT` on two of three consecutive
 * PRs (#550 at ~10.0s, #552 at 10117ms), passing unchanged on re-run both
 * times. The cost of that is not the re-runs, it is that a red gate people
 * expect to be spurious stops being read — and this is the ONLY gate in the
 * repo that can see a print regression at all.
 *
 * Deliberately not fixed by raising the ceiling: `execFileSync` is synchronous,
 * so vitest's own `testTimeout` cannot fire until Chrome returns, and a larger
 * value means a genuinely hung browser blocks the worker past the point vitest
 * would have reported — the failure would then name the wrong cause. See the
 * comment on the `timeout` option below.
 *
 * Best-effort by design: a generous timeout of its own, and any failure is
 * swallowed. If the warm-up cannot run, the measured call still runs and still
 * reports the real result — this only ever moves cost, never hides an outcome.
 */
function warmChrome(chrome: string): void {
	if (warmed) return;
	warmed = true;
	const dir = mkdtempSync(join(tmpdir(), "print-warmup-"));
	try {
		const htmlPath = join(dir, "warm.html");
		writeFileSync(htmlPath, "<!doctype html><html><body>warm</body></html>");
		execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				"--no-pdf-header-footer",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				`--print-to-pdf=${join(dir, "warm.pdf")}`,
				`file://${htmlPath}`,
			],
			// Generous: this is the call that pays the first-run cost, and it is
			// allowed to be slow precisely so the measured ones are not.
			{ stdio: "pipe", timeout: 60_000 },
		);
	} catch {
		// Swallowed on purpose — see the doc comment. A failed warm-up must never
		// turn into a failed page-count assertion.
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Render `html` through headless Chrome and return how many sheets it prints.
 *
 * Synchronous on purpose. Each call costs roughly a second, the suite makes one
 * per surface, and an async pool would buy a few seconds at the price of making
 * a failure much harder to attribute to a surface.
 */
export function printedPageCount(html: string): number {
	const chrome = findChrome();
	if (!chrome) {
		throw new Error(
			"No Chrome on PATH — cannot count printed pages. Tried: " +
				CHROME_BINARIES.join(", "),
		);
	}
	warmChrome(chrome);
	const dir = mkdtempSync(join(tmpdir(), "print-page-count-"));
	try {
		const htmlPath = join(dir, "page.html");
		const pdfPath = join(dir, "page.pdf");
		writeFileSync(htmlPath, html, "utf8");
		execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				// Required in this environment; the same reason /browse needs
				// GSTACK_CHROMIUM_NO_SANDBOX=1 here.
				"--no-sandbox",
				// Otherwise Chrome stamps a URL and page number into the margin,
				// which is not what the club prints.
				"--no-pdf-header-footer",
				// Hermetic, and isolated from the developer's real browser. Without
				// an explicit profile dir Chrome touches the default one; without the
				// resolver rule a fixture that ever gained a remote URL would make
				// the suite hit the network from a --no-sandbox browser.
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				`--print-to-pdf=${pdfPath}`,
				`file://${htmlPath}`,
			],
			// Below vitest's 15s testTimeout (vitest.config.ts). execFileSync is
			// SYNCHRONOUS, so vitest's own timer cannot fire until it returns — a
			// larger value here means a hung browser blocks the worker past the
			// point vitest would have reported, and the failure names the wrong
			// cause. Normal cost is ~360ms per surface.
			{ stdio: "pipe", timeout: 10_000 },
		);
		return countPdfPages(readFileSync(pdfPath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The natural, unscaled height in CSS px of the one element matching `selector`.
 *
 * Why this exists alongside the page count. `FitPage` shrinks a print surface to
 * fit its sheet, so on those layouts the PRINTED TYPE SIZE is not what the
 * component declares — it is that size times `PAGE_H / naturalHeight`. Editorial
 * declares 10.5px body text and printed it at about 6.4pt, because the layout
 * measured ~1299px into a 1056px page. The page count cannot see any of this: it
 * reports 1 whether the sheet is comfortable or crushed, which is exactly how a
 * layout gets 20% less legible with every gate green.
 *
 * So this is the gate for a change whose whole purpose is height, and the reason
 * a ceiling asserted on it has to be an ABSOLUTE number rather than one stated
 * relative to the font constants it protects — see the "test stated RELATIVE to
 * the constant it guards cannot fail" trap in CLAUDE.md.
 *
 * Two things it does that a naive read would get wrong:
 *
 *  · `minHeight` is cleared first. Static markup never runs `FitPage`'s
 *    measuring `useEffect`, so the inner div still carries the `minHeight:
 *    PAGE_H` it wears before a scale is known. Left alone, every surface with
 *    room to spare measures exactly 1056 and the headroom is invisible.
 *  · A selector matching nothing THROWS. Returning 0 or 1056 for "the hook is
 *    gone" would read as the roomiest possible layout and pass every ceiling —
 *    the same failure shape as the empty-document control beside the page
 *    counts, where a valid one-page PDF is not proof of content.
 *
 * Reads the number back through `document.title` because `--dump-dom`
 * serializes the post-script DOM but has no channel for a return value.
 * Fallback web fonts: the harness runs with `MAP * ~NOTFOUND`, so Fraunces and
 * Manrope never load here and these numbers are NOT comparable to a figure
 * measured against the deployed site. They are comparable to each other, which
 * is what a regression ceiling needs.
 */
export function measuredHeight(html: string, selector: string): number {
	const chrome = findChrome();
	if (!chrome) {
		throw new Error(
			"No Chrome — cannot measure natural height. Set CHROME_PATH, or install " +
				`one of: ${CHROME_BINARIES.join(", ")}`,
		);
	}
	warmChrome(chrome);
	const probe = `<script>
	(function () {
		// Every sheet, not just the target: a descendant measured while an ancestor
		// still wears minHeight PAGE_H is measuring the sheet, because the layouts
		// give their content column flex: 1 and it stretches to fill.
		document.querySelectorAll("[data-fit-inner]").forEach(function (p) {
			p.style.minHeight = "0";
		});
		var el = document.querySelector(${JSON.stringify(selector)});
		if (!el) { document.title = "MISSING"; return; }
		el.style.minHeight = "0";
		document.title = String(el.scrollHeight);
	})();
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "print-measure-"));
	try {
		const htmlPath = join(dir, "page.html");
		writeFileSync(htmlPath, html.replace("</body>", `${probe}</body>`), "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--virtual-time-budget=2000",
				"--dump-dom",
				`file://${htmlPath}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 10_000 },
		);
		const measured = dom.match(/<title>(\d+)<\/title>/);
		if (!measured) {
			throw new Error(
				`Could not measure "${selector}". Chrome reported ` +
					`${dom.match(/<title>([^<]*)<\/title>/)?.[1] ?? "no title"} — ` +
					"MISSING means the selector matched nothing.",
			);
		}
		return Number(measured[1]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
