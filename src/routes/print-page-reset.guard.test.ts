// Every standalone print route must cancel its screen-only page padding when
// printing, or it emits a blank second sheet.
//
// This is a real defect, not a hypothetical: the Word of the Day poster shipped
// without `.pgwrap { padding: 0 !important }` and every print produced two
// pages — 28 + 1056 + 28 = 1112px of content pushed into a 1056px page box by
// `@page { margin: 0 }`. Nothing in the repo could catch it, because print CSS
// had no test surface: jsdom performs no layout, and the failure only exists
// inside a paginating rendering engine.
//
// TWO THINGS CHANGED, and this file changed shape for both (#502).
//
// The rule now lives in ONE place — `PRINT_PAGE_CSS` in `print-theme.tsx` —
// rather than in three divergent copies, so the first half below asserts the
// primitive once instead of grepping each route. The older version of this file
// predicted that and suggested simply deleting itself at this point. That would
// have thrown away its best property: it discovered print routes by SCANNING the
// directory, so the fourth print route someone adds next year was enrolled
// automatically rather than forgotten. The second half keeps that, inverted — it
// no longer checks that each route carries the rule, it checks that no route
// hand-rolls its own page padding instead of using the shared constant.
//
// And the outcome itself is now tested directly. `print-page-count.test.tsx`
// renders each surface through headless Chrome and counts sheets; deleting the
// reset from `PRINT_PAGE_CSS` fails it with `expected 2 to be 1`, which is the
// v1.3.0.0 bug reproduced on demand. A source grep is the weaker check and is
// honest about that: it pins the RULE, the page-count harness pins the RESULT.
// Both are kept because they fail for different reasons — the grep catches a
// deletion in review, the harness catches a geometry change no grep can see.
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRINT_PAGE_CSS } from "#/components/agenda/print-theme";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));
/**
 * Comment-blind (see `#/test/guard-source`): these are "the rule must BE
 * present" assertions, so a file that only MENTIONS
 * `.pgwrap { padding: 0 !important }` in a comment explaining its reset would
 * satisfy them with the real rule deleted. Blanking comments also protects
 * `printBlock` below — a stray `}` in a comment inside the `@media print` block
 * would otherwise close the block early and hide the rules after it.
 */
const read = (file: string) => readSource(resolve(ROUTES, file));

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

describe("the shared print stylesheet keeps a sheet to one page", () => {
	const block = printBlock(PRINT_PAGE_CSS);

	it("has an @media print block at all", () => {
		expect(block).toBeTruthy();
	});

	it("resets .pgwrap padding when printing", () => {
		expect(
			block,
			"PRINT_PAGE_CSS gives .pgwrap a screen padding and must cancel it for " +
				"print. With @page margin 0 that padding overflows the page box and " +
				"emits a blank second sheet — the v1.3.0.0 bug.",
		).toMatch(/\.pgwrap\s*\{[^}]*padding:\s*0\s*!important/);
	});

	it("prints a full-bleed letter page", () => {
		// The reset is only load-bearing because the page box has no margin of its
		// own to absorb the padding. Pinning both together keeps that reasoning true.
		expect(block).toMatch(
			/@page\s*\{[^}]*size:\s*letter portrait;[^}]*margin:\s*0/,
		);
	});

	it("hides the screen-only toolbar when printing", () => {
		expect(block).toMatch(/\.no-print\s*\{[^}]*display:\s*none\s*!important/);
	});

	it("pairs a forced page break with a cancel on the last sheet", () => {
		// Half of this pair is how you get a trailing blank page. The poster used
		// to carry neither, which was safe; carrying only the first would not be.
		expect(block).toMatch(/\.agenda-page\s*\{[^}]*break-after:\s*page/);
		expect(block).toMatch(
			/\.agenda-page:last-child\s*\{[^}]*break-after:\s*auto/,
		);
	});
});

/**
 * Routes that render a print sheet, discovered by scanning rather than listed,
 * so a new one is enrolled the moment it is written.
 */
const printRoutes = readdirSync(ROUTES)
	.filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
	.filter((f) => read(f).includes("PRINT_PAGE_CSS"))
	.sort();

describe("no print route hand-rolls its own page CSS", () => {
	// Without this the suite passes vacuously if the constant is renamed or the
	// scan stops matching — which is exactly how the original bug survived.
	it("finds the print routes (so a rename can't make this vacuous)", () => {
		expect(printRoutes).toContain("club.$clubId_.meeting.$meetingId.word.tsx");
		expect(printRoutes).toContain("club.$clubId_.meeting.$meetingId.print.tsx");
		expect(printRoutes).toContain("club.$clubId_.roles.tsx");
	});

	for (const file of readdirSync(ROUTES).filter(
		(f) => f.endsWith(".tsx") && !f.includes(".test."),
	)) {
		it(`${file} does not declare its own .pgwrap padding`, () => {
			// Padding belongs to PRINT_PAGE_CSS alone now. A route that sets its own
			// is either a copy that will drift, or a new print surface that skipped
			// the shared constant — the two ways this regression comes back.
			expect(
				read(file),
				`${file} sets a .pgwrap padding of its own. Import PRINT_PAGE_CSS from ` +
					"#/components/agenda/print-theme instead; it carries the padding and " +
					"the print reset together, which is the pairing that matters.",
			).not.toMatch(/\.pgwrap\s*\{[^}]*padding:/);
		});
	}
});
