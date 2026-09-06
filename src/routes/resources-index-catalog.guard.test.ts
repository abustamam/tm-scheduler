/**
 * The resources index renders the filterable catalog, unconditionally, INSIDE
 * the shell (#313).
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
 * reading affordance, not a marketing one, so a refactor that gave it to only
 * one branch would quietly take it from half the readers.
 *
 * ## Why textual ORDER is not enough
 *
 * The first version of this guard asserted only that `<ResourcesShell`,
 * `<ResourceCatalog` and `</ResourcesShell>` appeared in that order. Review
 * found the hole: `{authCtx ? <ResourceCatalog /> : <LegacyGrid />}` written
 * INSIDE the shell keeps all three anchors in that exact order, stays green,
 * and drops the filter for anonymous visitors — the precise criterion this file
 * exists to protect. Order pins where, not whether.
 *
 * `jsxBraceDepthAt` closes it. Conditional rendering in JSX has to go through a
 * `{…}` expression container, so a catalog that survives only inside one is at
 * brace depth ≥ 1, while an unconditional JSX child sits at depth 0. Both
 * mutations above (`? :` and `&&`) fail on that, and the two the old guard
 * already caught still fail on order.
 *
 * Comment-blind via `readSource`: every assertion here is "this must BE present
 * / in this position", and the route carries a comment naming both elements, so
 * a raw read could match the comment instead of the JSX. Blanking also keeps
 * the depth scan honest — a brace inside a comment would otherwise skew it.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/resources.index.tsx";

/**
 * How many unclosed `{` sit between `from` and `to`. Zero means `to` is a plain
 * JSX child; anything higher means it is inside an expression container, which
 * in a route body is a conditional.
 *
 * Lexical, not a parser (same tradeoff `#/test/guard-source` documents): it does
 * not track braces inside string or template literals. That can only ADD depth
 * the JSX does not have, i.e. produce a false FAILURE a human sees immediately —
 * the safe direction for a guard. Attribute braces (`shell={shell}`) and blanked
 * JSX comments are balanced, so they net to zero.
 */
function jsxBraceDepthAt(src: string, from: number, to: number): number {
	let depth = 0;
	for (let i = from; i < to; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") depth--;
	}
	return depth;
}

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

	it("renders it UNCONDITIONALLY, not gated on the shell branch", () => {
		const src = readSource(ROUTE);
		const shellOpen = src.indexOf("<ResourcesShell");
		const catalog = src.indexOf("<ResourceCatalog");
		expect(shellOpen).toBeGreaterThan(-1);
		expect(catalog).toBeGreaterThan(-1);

		expect(
			jsxBraceDepthAt(src, shellOpen, catalog),
			"<ResourceCatalog /> sits inside a {…} expression, so it is rendered " +
				"conditionally. The filter must reach BOTH shell branches — gating it " +
				"on authCtx/shell silently drops it for anonymous visitors.",
		).toBe(0);
	});

	it("the depth scan really detects a conditional (self-test)", () => {
		// Without this the assertion above passes on any depth function that
		// always returns 0 — including one broken by a future edit.
		const gated = `<ResourcesShell shell={shell}>{authCtx ? <ResourceCatalog /> : <LegacyGrid />}</ResourcesShell>`;
		expect(
			jsxBraceDepthAt(
				gated,
				gated.indexOf("<ResourcesShell"),
				gated.indexOf("<ResourceCatalog"),
			),
		).toBeGreaterThan(0);

		const anded = `<ResourcesShell shell={shell}>{shell && <ResourceCatalog />}</ResourcesShell>`;
		expect(
			jsxBraceDepthAt(
				anded,
				anded.indexOf("<ResourcesShell"),
				anded.indexOf("<ResourceCatalog"),
			),
		).toBeGreaterThan(0);

		const plain = `<ResourcesShell shell={shell} authCtx={authCtx}><ResourceCatalog /></ResourcesShell>`;
		expect(
			jsxBraceDepthAt(
				plain,
				plain.indexOf("<ResourcesShell"),
				plain.indexOf("<ResourceCatalog"),
			),
		).toBe(0);
	});
});
