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
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRINT_PAGE_CSS } from "#/components/agenda/print-theme";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));
/**
 * TWO readers, because this file now holds BOTH guard classes and
 * `#/test/guard-source` moves them in OPPOSITE directions. Blanket-applying
 * either one is a bypass, and this file has now made that mistake in both
 * directions — the first version read everything comment-BLIND, which let a
 * comment satisfy a negative assertion; the fix over-corrected to raw for
 * everything, which let a comment satisfy a POSITIVE one. The roles route
 * mentions `PRINT_PAGE_CSS` in a comment explaining what cannot be hoisted
 * into it, so with a raw read that route could serve no print stylesheet at
 * all and every assertion here still passed. Verified.
 *
 * `readRaw` — for "the offender list must be EMPTY" (`.not.toMatch`).
 * Stripping can only DELETE text, which for a negative assertion is a false
 * PASS, and the stripper is lexical and does not track the template literals
 * these routes carry their CSS in. Same reason `ti-wordmark` and
 * `server-modules` read raw.
 *
 * `readStripped` — for "this pattern must BE present". There a comment
 * mentioning the pattern is the bypass, which is the case this module exists
 * to close.
 */
const readRaw = (file: string) => readFileSync(resolve(ROUTES, file), "utf8");
const readStripped = (file: string) => readSource(resolve(ROUTES, file));

/**
 * The `@media print { … }` body, brace-matched rather than regex-matched: the
 * block contains a nested `@page { … }`, so a lazy `[^}]*` would stop early and
 * a greedy one would run past the end of the block.
 */
function printBlock(raw: string): string | null {
	// Strip CSS comments first: PRINT_PAGE_CSS carries one inside its
	// `@media print` block, and a `}` added to it would end the block early and
	// hide every rule after it.
	const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
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
		// The cancel is DEFENSIVE, not a demonstrated fix. It is worth stating
		// plainly because the opposite was claimed here first: Chrome discards a
		// forced break after the last box, so removing the `:last-child` rule
		// produces no trailing blank page on any of the six surfaces — verified
		// by mutation, and reproducible in thirty seconds with the harness next
		// door. It stays because paged-media backends differ and the rule costs
		// nothing, not because this repo has ever seen it bite.
		expect(block).toMatch(/\.agenda-page\s*\{[^}]*break-after:\s*page/);
		expect(block).toMatch(
			/\.agenda-page:last-child\s*\{[^}]*break-after:\s*auto/,
		);
	});

	// The rules below are pinned HERE and nowhere else. A review mutation sweep
	// showed the page-count harness keeps all six counts unchanged when each of
	// them is deleted, so these greps are their only coverage. Deleting a grep
	// because "the harness covers it" would silently uncover the rule.
	it("cancels the agenda's inter-sheet gap when printing", () => {
		// `TwoPage` sets an inline `gap: 26` to space its two sheets on screen.
		// Unreset, that becomes a 26px band between printed pages.
		expect(block).toMatch(/\.pgwrap\s*\{[^}]*gap:\s*0\s*!important/);
	});

	it("keeps a sheet from being split across pages", () => {
		expect(block).toMatch(/\.agenda-page\s*\{[^}]*break-inside:\s*avoid/);
	});

	it("drops the on-screen sheet shadow when printing", () => {
		expect(block).toMatch(
			/\.agenda-page\s*\{[^}]*box-shadow:\s*none\s*!important/,
		);
	});
});

/**
 * Every route file, walked RECURSIVELY.
 *
 * The previous version used a flat `readdirSync`, which was blind to the 26
 * route files under `_authed/**` — including `_authed/admin/vp-membership.tsx`,
 * which serves its own `@media print` block today. That route is deliberately a
 * different shape (it hides everything except a QR tent and uses
 * `@page { margin: 24px }`, not a full-bleed letter sheet), so it does not want
 * the shared constant; the check below is a negative assertion, so it passes
 * cleanly while the walk stops claiming a coverage it did not have.
 */
function routeFiles(dir: string = ROUTES): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const abs = join(dir, e.name);
		if (e.isDirectory()) return routeFiles(abs);
		if (!e.name.endsWith(".tsx") || e.name.includes(".test.")) return [];
		return [relative(ROUTES, abs)];
	});
}

const ALL_ROUTES = routeFiles().sort();

/** The routes that opted into the shared stylesheet. */
// Comment-BLIND: this is a "must BE present" check, so a route that merely
// MENTIONS the constant in a comment must not satisfy it.
const routesUsingSharedCss = ALL_ROUTES.filter((f) =>
	readStripped(f).includes("PRINT_PAGE_CSS"),
);

describe("no print route hand-rolls its own page CSS", () => {
	// Pins that the three known sheet routes really do consume the shared
	// constant. Not a vacuity guard for the loop below — that iterates every
	// route file regardless — but it catches a rename or a route quietly
	// dropping the import.
	it("the three sheet routes consume the shared stylesheet", () => {
		expect(routesUsingSharedCss).toContain(
			"club.$clubId_.meeting.$meetingId.word.tsx",
		);
		expect(routesUsingSharedCss).toContain(
			"club.$clubId_.meeting.$meetingId.print.tsx",
		);
		expect(routesUsingSharedCss).toContain("club.$clubId_.roles.tsx");
	});

	it("walks a non-trivial route tree (so a broken walk can't pass vacuously)", () => {
		expect(ALL_ROUTES.length).toBeGreaterThan(20);
	});

	for (const file of ALL_ROUTES) {
		it(`${file} does not declare its own .pgwrap padding`, () => {
			// Padding belongs to PRINT_PAGE_CSS alone now. A route that sets its own
			// is either a copy that will drift, or a new print surface that skipped
			// the shared constant — the two ways this regression comes back.
			expect(
				readRaw(file),
				`${file} sets a .pgwrap padding of its own. Import PRINT_PAGE_CSS from ` +
					"#/components/agenda/print-theme instead; it carries the padding and " +
					"the print reset together, which is the pairing that matters.",
			).not.toMatch(/\.pgwrap\s*\{[^}]*padding:/);
		});
	}
});
