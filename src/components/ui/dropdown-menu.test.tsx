// @vitest-environment jsdom
//
// The other half of the /qa 2026-08-10 link-color fix (#541).
//
// `export-menu-link-color.guard.test.ts` greps `styles.css` for the
// `:not([data-slot="dropdown-menu-item"])` exclusion. That grep pins the CSS
// and nothing else: it is structurally blind to the DOM side of the contract.
// If `<DropdownMenuItem>` stopped emitting `data-slot="dropdown-menu-item"` —
// a re-run of `bunx shadcn@latest add dropdown-menu` against a future upstream,
// or a Radix change that stops merging the attribute onto an `asChild` child —
// the selector would match nothing, every `<Link>` item would go back to
// link-teal beside its `<button>` peers, and BOTH existing gates would stay
// green (the grep still finds its string; jsdom component tests see no color).
//
// So this asserts the two ends against each other: it reads the REAL selector
// out of `styles.css` and runs it against the REAL DOM the component renders,
// via `Element.matches` — which needs no layout and no stylesheet, so jsdom can
// answer it. It fails if either side moves.
//
// `readSource` (comment-blind) for the same reason the CSS guard uses it: the
// rule could be commented out and a raw read would still find the selector.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./dropdown-menu";

const STYLES = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../styles.css",
);

/**
 * The unlayered text-link selector, lifted verbatim from the stylesheet rather
 * than retyped here — a copy would drift from the rule it claims to describe,
 * and the whole point is to test the shipped selector.
 *
 * The `:hover` variant is skipped explicitly. Its selector string CONTAINS the
 * base one as a prefix, which is a live blind spot next door:
 * `export-menu-link-color.guard.test.ts`'s two `toContain` assertions are not
 * independent for that reason, and deleting the base rule outright leaves that
 * guard green (verified by mutation). Matching `:hover` here would import the
 * same confusion — `Element.matches(':hover')` is false in jsdom for reasons
 * that have nothing to do with this contract.
 */
function linkRuleSelector(): string {
	const selectors = [
		...readSource(STYLES).matchAll(/^(a:not\([^{\n]*?)\s*\{$/gm),
	]
		.map((m) => m[1])
		.filter((s) => !s.includes(":hover"));
	if (selectors.length === 0)
		throw new Error(
			"could not find the base (non-:hover) `a:not(...) {` text-link rule in " +
				"styles.css — if it was renamed or restructured, update this " +
				"extraction; if it was DELETED, that is the bug, not the test.",
		);
	return selectors[0];
}

afterEach(cleanup);

function renderMenu() {
	render(
		<DropdownMenu defaultOpen>
			<DropdownMenuTrigger>Print &amp; export</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuItem asChild>
					<a href="/club/downtown/roles">All role sheets</a>
				</DropdownMenuItem>
				<DropdownMenuItem>This meeting's role sheets…</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>,
	);
}

describe("DropdownMenuItem's data-slot contract with the global link rule", () => {
	it("stamps data-slot='dropdown-menu-item' onto an asChild anchor", () => {
		renderMenu();
		const anchor = screen.getByText("All role sheets").closest("a");
		expect(
			anchor?.getAttribute("data-slot"),
			"the exclusion in styles.css keys on this attribute; without it every " +
				"<Link> menu item renders in link-teal beside its <button> peers.",
		).toBe("dropdown-menu-item");
	});

	it("the stylesheet's text-link rule does NOT select that anchor", () => {
		renderMenu();
		const anchor = screen.getByText("All role sheets").closest("a");
		expect(anchor).toBeTruthy();
		expect(
			(anchor as HTMLAnchorElement).matches(linkRuleSelector()),
			"the shipped `a:not(…)` rule still matches a dropdown menu item — the " +
				"link-teal/foreground split /qa found on 2026-08-10 is back.",
		).toBe(false);
	});

	it("but the rule still selects an ordinary text link (the rule is not neutered)", () => {
		// The control. Without it, deleting the rule's real work — widening the
		// :not() until it excludes everything — would pass the assertion above.
		render(
			<p>
				<a href="/resources">Resources</a>
			</p>,
		);
		const plain = screen.getByText("Resources") as HTMLAnchorElement;
		expect(
			plain.matches(linkRuleSelector()),
			"a bare text link must still take the text-link styling — an exclusion " +
				"broad enough to drop this one has turned the whole rule off.",
		).toBe(true);
	});
});
