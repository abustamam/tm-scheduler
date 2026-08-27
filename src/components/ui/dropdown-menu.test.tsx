// @vitest-environment jsdom
//
// `DropdownMenuItem`'s `data-slot` DOM contract. Originally the second half of
// the /qa 2026-08-10 link-color fix (#541), when the global text-link rule was
// UNLAYERED and `:not([data-slot="dropdown-menu-item"])` was what kept every
// `<Link>` menu item from rendering link-teal beside its `<button>` peers.
//
// #646 deleted that exclusion — the rule moved into `@layer base`, so a
// component's own colour utility wins by layer order and no anchor needs
// escaping. Two tests here went with it: they lifted the `a:not(…)` selector
// out of `styles.css` and ran `Element.matches` against it, which is a test of
// a mechanism that no longer exists. `text-link-layering.guard.test.ts` now
// holds the stylesheet half.
//
// What survives is the shadcn DOM contract on its own terms, and it is still
// worth pinning: if `<DropdownMenuItem>` stopped emitting the attribute — a
// re-run of `bunx shadcn@latest add dropdown-menu` against a future upstream,
// or a Radix change that stops merging props onto an `asChild` child — the
// three suites that use `data-slot` as a selector would silently stop finding
// their elements, and no component test would notice.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./dropdown-menu";

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

describe("DropdownMenuItem stamps data-slot on an asChild anchor", () => {
	it("stamps data-slot='dropdown-menu-item' onto an asChild anchor", () => {
		renderMenu();
		const anchor = screen.getByText("All role sheets").closest("a");
		expect(
			anchor?.getAttribute("data-slot"),
			"three suites use this attribute as their selector for menu items. " +
				"Radix must keep merging it onto the `asChild` child.",
		).toBe("dropdown-menu-item");
	});
});
