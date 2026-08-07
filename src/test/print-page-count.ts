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

/**
 * The first usable Chrome on PATH, or null.
 *
 * Exported so the suite can distinguish "no browser here" from "the browser
 * disagreed" — see `describeIfChrome`, which refuses to let the second hide
 * behind the first in CI.
 */
export function findChrome(): string | null {
	for (const bin of CHROME_BINARIES) {
		try {
			execFileSync("command", ["-v", bin], {
				shell: "/bin/sh",
				stdio: "pipe",
			});
			return bin;
		} catch {
			// not on PATH; try the next one
		}
	}
	return null;
}

/**
 * Page objects in a PDF.
 *
 * `/Type /Page` with a negative lookahead for the `s`: the document's page-tree
 * root is `/Type /Pages`, and counting it would report every one-page sheet as
 * two. Same technique the react-pdf role-sheet assertions use.
 */
export function countPdfPages(pdf: Buffer): number {
	return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

/**
 * Wrap rendered markup in a minimal document.
 *
 * `body { margin: 0 }` is NOT cosmetic and must not be dropped: the real app
 * gets it from `styles.css`, `@page` sets `margin: 0`, and the print surfaces
 * are sized to exactly one letter page. A default 8px body margin pushes
 * 1056px of content past the page box and emits a blank second sheet — which
 * is the v1.3.0.0 bug, reproduced by omission.
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
				`--print-to-pdf=${pdfPath}`,
				`file://${htmlPath}`,
			],
			{ stdio: "pipe", timeout: 60_000 },
		);
		return countPdfPages(readFileSync(pdfPath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
