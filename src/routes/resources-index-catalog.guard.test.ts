/**
 * The resources index renders the filterable catalog, INSIDE the shell (#313).
 *
 * ## Why a source guard
 *
 * `<ResourceCatalog>` is behaviour-tested where it can be mounted
 * (`src/components/resources/resource-catalog.test.tsx`). What no render test
 * can see is the half that lives in a route file, because a route cannot be
 * mounted in vitest: that the index calls it at all, and WHERE.
 *
 * Where matters. `ResourcesShell` has two branches — the full app sidebar for a
 * signed-in member with a club, the light header for an anonymous visitor — and
 * it picks one AROUND its children. Anything rendered as a child therefore
 * reaches both branches by construction, and nothing else does. The filter is a
 * reading affordance, not a marketing one, so a refactor that lifted it out of
 * the shell's children (or duplicated it into one branch) would quietly give it
 * to half the readers. That is a position in the source, which is checkable.
 *
 * Comment-blind via `readSource`: every assertion here is "this must BE
 * present / in this order", and the route carries a comment naming both
 * elements, so a raw read could match the comment instead of the JSX.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/resources.index.tsx";

describe("the resources index renders the filterable catalog", () => {
	it("imports and renders <ResourceCatalog />", () => {
		const src = readSource(ROUTE);
		expect(src).toMatch(
			/import\s*\{[^}]*ResourceCatalog[^}]*\}\s*from\s*"#\/components\/resources\/resource-catalog"/,
		);
		expect(src).toMatch(/<ResourceCatalog\b/);
	});

	it("renders it as a child of <ResourcesShell>, so both shell branches get it", () => {
		const src = readSource(ROUTE);
		const shellOpen = src.indexOf("<ResourcesShell");
		const catalog = src.indexOf("<ResourceCatalog");
		const shellClose = src.indexOf("</ResourcesShell>");

		// Anti-vacuity: with any anchor missing, the ordering assertions below
		// would compare -1 against a real index and pass for the wrong reason.
		expect(
			shellOpen,
			"<ResourcesShell> not found in the route",
		).toBeGreaterThan(-1);
		expect(
			catalog,
			"<ResourceCatalog /> not found in the route",
		).toBeGreaterThan(-1);
		expect(
			shellClose,
			"</ResourcesShell> not found in the route",
		).toBeGreaterThan(-1);

		expect(
			shellOpen,
			"<ResourceCatalog /> must be INSIDE <ResourcesShell> — outside it, the " +
				"shell's anonymous/signed-in branch no longer wraps it.",
		).toBeLessThan(catalog);
		expect(catalog).toBeLessThan(shellClose);
	});
});
