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

/** Binaries that can drive `--print-to-pdf`, most preferred first. */
const CHROME_BINARIES = [
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
];

/** Memoized: `findChrome` is called once per surface and the answer cannot change. */
let cachedChrome: string | null | undefined;

/**
 * The first usable Chrome on PATH, or null.
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
export function findChrome(): string | null {
	if (cachedChrome !== undefined) return cachedChrome;
	for (const bin of CHROME_BINARIES) {
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
