/**
 * Unit tests for the page-count harness's own helpers.
 *
 * These exist because the harness sits UNDER every print assertion, so a silent
 * failure here greens everything above it rather than failing loudly. A ship
 * audit made that concrete: replacing `countPdfPages`'s "no page tree" throw
 * with a guessed `return 1` left all eight page-count assertions passing —
 * four of them are `toBe(1)`, so a counter that always answered 1 would satisfy
 * them no matter what Chrome actually emitted. The same audit showed
 * `Math.max` -> `Math.min` and a revert to the naive `/Type /Page` counter both
 * survived for the same reason.
 *
 * No browser here on purpose. These are pure functions over bytes and strings;
 * the Chrome-driven assertions live in `print-page-count.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { countPdfPages, printableDocument } from "./print-page-count";

/** A minimal PDF-shaped buffer. Only the bytes these functions read matter. */
function pdf(body: string): Buffer {
	return Buffer.from(`%PDF-1.4\n${body}\n%%EOF`, "latin1");
}

describe("countPdfPages", () => {
	it("reads the page count off the page-tree root", () => {
		expect(
			countPdfPages(pdf("<< /Type /Pages /Kids [1 0 R] /Count 1 >>")),
		).toBe(1);
		expect(
			countPdfPages(pdf("<< /Type /Pages /Kids [1 0 R] /Count 7 >>")),
		).toBe(7);
	});

	it("throws rather than guessing when there is no page tree", () => {
		// The load-bearing one. Guessing a number here — 1 especially — would
		// satisfy most of the assertions built on top of this and hide whatever
		// went wrong upstream.
		expect(() => countPdfPages(pdf("<< /Type /Catalog >>"))).toThrow(
			/No \/Type \/Pages/,
		);
		expect(() => countPdfPages(Buffer.alloc(0))).toThrow();
	});

	it("takes the ROOT count on a nested page tree, not an intermediate one", () => {
		// Intermediate nodes carry their own /Count; only the root's is the total,
		// and it is the largest. Math.min here would report a subtree.
		const nested = pdf(
			"<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 5 >>\n" +
				"<< /Type /Pages /Kids [4 0 R] /Count 2 >>\n" +
				"<< /Type /Pages /Kids [5 0 R] /Count 3 >>",
		);
		expect(countPdfPages(nested)).toBe(5);
	});

	it("is not fooled by page-object syntax appearing in document metadata", () => {
		// Chrome writes the document title into /Info and link hrefs into
		// /Annots /URI UNCOMPRESSED. Counting `/Type /Page` objects therefore lets
		// CONTENT inflate the number — and the real print routes DO set a title
		// (via `meetingPdfBasename`), even though the harness fixtures do not.
		const ambush = pdf(
			"<< /Type /Pages /Kids [1 0 R] /Count 1 >>\n" +
				"<< /Title (/Type /Page and again /Type /Page) >>\n" +
				"<< /Type /Annot /Subtype /Link /URI (http://x/\\/Type /Page) >>",
		);
		expect(countPdfPages(ambush)).toBe(1);
	});
});

describe("printableDocument", () => {
	it("emits the zero-margin reset the page geometry depends on", () => {
		// Without this the browser's default 8px body margin pushes a 1056px sheet
		// past the page box and adds a blank second page — the v1.3.0.0 bug,
		// reproduced by omission.
		const html = printableDocument("", "");
		expect(html).toMatch(/html,\s*body\s*\{[^}]*margin:\s*0/);
		expect(html).toMatch(/html,\s*body\s*\{[^}]*padding:\s*0/);
	});

	it("inlines the caller's stylesheet and body", () => {
		const html = printableDocument(".x { color: red; }", "<p>hello</p>");
		expect(html).toContain(".x { color: red; }");
		expect(html).toContain("<p>hello</p>");
	});

	it("emits no <title>, which would otherwise reach the PDF metadata", () => {
		// Related to the ambush case above: a title lands uncompressed in /Info.
		// The count is robust to it now, but not emitting one keeps the fixture
		// closer to a bare sheet.
		expect(printableDocument("", "<p>x</p>")).not.toMatch(/<title>/i);
	});
});
