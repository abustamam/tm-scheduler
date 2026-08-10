// The global text-link rule in `styles.css` is UNLAYERED, so it beats any
// layered Tailwind utility a component sets on an anchor. That is not a
// hypothetical: the rule already had to grow one exclusion when it washed out
// `<Button asChild>` (the landing "Sign in" button read teal-on-teal in dark
// mode), and /qa found it doing the same thing a second time on 2026-08-10.
//
// The meeting "Print & export" menu (#541) mixes `<DropdownMenuItem asChild>`
// + `<Link>` items with plain `<DropdownMenuItem>` button items. Without the
// `[data-slot="dropdown-menu-item"]` exclusion the four link items rendered in
// link-teal (rgb(50,143,151)) and the two button items in foreground
// (rgb(23,58,64)) — one menu of peer actions split into two apparent classes,
// with "All role sheets" and "This meeting's role sheets…" sitting adjacent in
// different colors.
//
// Nothing else in this repo can catch that. jsdom loads no stylesheet, so
// component tests see no color at all; the print page-count harness inlines
// only the PRINT stylesheet and never loads a screen surface; typecheck and
// lint have no view of the cascade. So this is a source grep on the CSS.
//
// COMMENT-BLIND (`readSource`) is mandatory: both assertions are of the "this
// pattern must BE present" form, and this very file quotes the selector it
// checks for — a raw read of `styles.css` would also pass on a commented-out
// rule. See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "../../styles.css");

describe("the unlayered text-link rule leaves component-colored anchors alone", () => {
	// Both rules are matched as WHOLE selector lines (anchored `^…{$`), not with
	// `toContain`. The two substring assertions this replaces were NOT
	// independent: the `:hover` selector string contains the base selector as a
	// prefix, so deleting the base rule outright left both green — mutation-
	// verified during the ship review. Anchoring each to its own line is what
	// makes "the base rule exists" and "the hover rule exists" separable facts.
	// PREFIX match, not the single `dropdown-menu-item` slot: four slots in
	// dropdown-menu.tsx accept `asChild` and can become an anchor (item,
	// checkbox-item, radio-item, sub-trigger). Naming one left the same
	// link-teal/foreground split reachable one component away (red-team review).
	const SELECTOR =
		'a:not([data-slot="button"]):not([data-slot^="dropdown-menu-"])';

	/** Whole-line selector match, so a longer selector cannot satisfy a shorter one. */
	function hasRule(selector: string): boolean {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`^${escaped}\\s*\\{$`, "m").test(readSource(STYLES));
	}

	it("excludes dropdown menu items, so a <Link> item matches its <button> peers", () => {
		expect(
			hasRule(SELECTOR),
			'the global `a:not([data-slot="button"])` rule must ALSO exclude ' +
				'[data-slot="dropdown-menu-item"] — without it every <Link> rendered ' +
				"through `<DropdownMenuItem asChild>` takes link-teal while its " +
				"button siblings keep the foreground color, splitting one menu into " +
				`two visual classes (#541, found by /qa 2026-08-10). Expected a line \`${SELECTOR} {\`.`,
		).toBe(true);
	});

	it("applies the same exclusion to the :hover rule", () => {
		// The hover rule is a separate selector; excluding only the base rule
		// leaves the teal reappearing under the cursor, which reads as a
		// different kind of item exactly when the user is about to click it.
		expect(
			hasRule(`${SELECTOR}:hover`),
			"the :hover half of the text-link rule needs the same exclusion, or " +
				"menu items flip to link-teal on hover.",
		).toBe(true);
	});
});
