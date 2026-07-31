// Every standalone print route must cancel its screen-only page padding when
// printing, or it emits a blank second sheet.
//
// This is a real defect, not a hypothetical: the Word of the Day poster shipped
// without `.pgwrap { padding: 0 !important }` and every print produced two
// pages — 28 + 1056 + 28 = 1112px of content pushed into a 1056px page box by
// `@page { margin: 0 }`. Nothing in the repo could catch it, because print CSS
// has no test surface: jsdom performs no layout, and the failure only exists
// inside a paginating rendering engine. It was found by extracting the CSS and
// counting pages in headless Chrome.
//
// A source grep is a weaker check than counting pages, and it is honest about
// that: it pins the RULE, not the rendered outcome. What it buys is coverage of
// a route SET — the reset is byte-identical in three routes today, and the
// fourth print route someone adds next year is the one at risk. Discovery is by
// scanning for the pattern rather than a hardcoded list, so a new print route
// is enrolled automatically instead of being forgotten.
//
// If `PRINT_PAGE_CSS` is ever extracted into a shared primitive (TODOS.md), the
// right move is to delete this and assert the primitive once.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTES = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(resolve(ROUTES, file), "utf8");

/**
 * The `@media print { … }` body, brace-matched rather than regex-matched: the
 * block contains a nested `@page { … }`, so a lazy `[^}]*` would stop early and
 * a greedy one would run past the end of the block.
 */
function printBlock(src: string): string | null {
	const at = src.indexOf("@media print");
	if (at === -1) return null;
	const open = src.indexOf("{", at);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return null;
}

/** Routes that give `.pgwrap` a screen padding, and so need the print reset. */
const printRoutes = readdirSync(ROUTES)
	.filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
	.filter((f) => /\.pgwrap\s*\{[^}]*padding:\s*(?!0)/.test(read(f)))
	.sort();

describe("standalone print routes cancel their screen padding when printing", () => {
	// Without this the suite passes vacuously if the class is renamed or the
	// scan stops matching — which is exactly how the original bug survived.
	it("finds the print routes (so a rename can't make this vacuous)", () => {
		expect(printRoutes).toContain("club.$clubId_.meeting.$meetingId.word.tsx");
		expect(printRoutes).toContain("club.$clubId_.meeting.$meetingId.print.tsx");
		expect(printRoutes).toContain("club.$clubId_.roles.tsx");
	});

	for (const file of printRoutes) {
		it(`${file} resets .pgwrap padding inside @media print`, () => {
			const block = printBlock(read(file));
			expect(block, `${file} has no @media print block`).toBeTruthy();
			expect(
				block,
				`${file} sets a screen padding on .pgwrap but never resets it for ` +
					`print. With @page margin 0 that padding overflows the page box and ` +
					`emits a blank second sheet. Add: .pgwrap { padding: 0 !important; }`,
			).toMatch(/\.pgwrap\s*\{[^}]*padding:\s*0\s*!important/);
		});

		// The reset is only load-bearing because the page box has no margin of its
		// own to absorb the padding. Pinning both together keeps the comment
		// explaining the reset true.
		it(`${file} prints a full-bleed letter page`, () => {
			expect(printBlock(read(file))).toMatch(
				/@page\s*\{[^}]*size:\s*letter portrait;[^}]*margin:\s*0/,
			);
		});

		it(`${file} hides its screen-only toolbar when printing`, () => {
			expect(printBlock(read(file))).toMatch(
				/\.no-print\s*\{[^}]*display:\s*none\s*!important/,
			);
		});
	}
});
