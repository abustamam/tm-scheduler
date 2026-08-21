/**
 * Regression: the search box on /resources/evaluation-resources must come
 * BEFORE the article prose.
 * Found by /qa on 2026-08-20.
 * Report: .gstack/qa-reports/qa-report-localhost-2026-08-20.md
 *
 * ## What broke
 *
 * The registered article was rendered at the top of the page, above the search
 * input. Measured in a real browser at 375x812: the search box sat at y=1146,
 * which is 334px below the fold, behind four headings and five paragraphs. The
 * page exists so a member can find one form fast — on a phone, mid-meeting —
 * so the primary action starting off-screen defeats it.
 *
 * ## Why a source guard and not a render test
 *
 * Two reasons, and the first is the repo's standing rule: a route cannot be
 * mounted in vitest, so there is no seam to render. The second is that the
 * defect's SYMPTOM was geometry (a fold position), which jsdom cannot see at
 * all because it performs no layout — the same reason the print surfaces need
 * headless Chrome.
 *
 * But the CAUSE is not geometry, it is DOM ORDER, and order is plain structure.
 * So this guard pins the thing that actually regressed: which element comes
 * first in the source. That is checkable, and it fails on the exact revert that
 * matters. It deliberately asserts nothing about pixels — a future redesign is
 * free to move things as long as the tool still precedes the prose.
 *
 * Comment-blind via `readSource`: every assertion here is of the "this must BE
 * present / in this order" form, and this file's own header quotes both element
 * names, so reading the route raw could match a comment rather than the JSX.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/resources.evaluation-resources.tsx";

describe("evaluation-resources page puts the tool before the prose", () => {
	it("renders the search input before the article", () => {
		const src = readSource(ROUTE);
		const search = src.indexOf('aria-label="Search evaluation resources"');
		const article = src.indexOf("<article");

		// Anti-vacuity: if either anchor stops matching, the ordering assertion
		// below would compare -1 against a real index and pass for the wrong
		// reason. Pin both are present first.
		expect(search, "search input not found in the route").toBeGreaterThan(-1);
		expect(article, "article element not found in the route").toBeGreaterThan(
			-1,
		);
		expect(
			search,
			"the search box must precede the article — prose above it pushed the box below the fold on a phone",
		).toBeLessThan(article);
	});

	it("still renders the article somewhere on the page", () => {
		// The article is the ONLY place this slug's prose reaches a URL: the static
		// route beats `resources.$slug`, so dropping it here strands the committed
		// markdown with no reader. Moving it must not become deleting it.
		const src = readSource(ROUTE);
		expect(src).toContain("<article");
		expect(src).toContain("ReactMarkdown");
		expect(src).toContain('getResourceMarkdown("evaluation-resources")');
	});
});
