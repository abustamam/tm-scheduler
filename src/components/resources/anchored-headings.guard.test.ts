/**
 * The resource article route must render its markdown through
 * `anchoredHeadingComponents` (#941). A route cannot be mounted in vitest
 * without its server context, so this pins the wiring by source. Without the
 * prop, an article renders `{#base-camp}` as visible text and every section
 * link (the orientation checklist's included) lands at the top of the page.
 *
 * Comment-blind (`readSource`): this is a must-be-present guard, so a comment
 * quoting the prop must not satisfy it.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/resources.$slug.tsx";

describe("the resource article route", () => {
	it("renders markdown through the anchored heading components", () => {
		const src = readSource(ROUTE);
		expect(src).toMatch(
			/import\s*\{[^}]*anchoredHeadingComponents[^}]*\}\s*from\s*"#\/components\/resources\/anchored-headings"/,
		);
		expect(src).toMatch(/components=\{anchoredHeadingComponents\}/);
	});
});
