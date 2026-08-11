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
	// Matched as WHOLE selector LINES, then split into the base rule and its
	// `:hover`. The two substring assertions this replaces were NOT independent —
	// the `:hover` selector contains the base selector as a prefix, so deleting
	// the base rule outright left both green (mutation-verified during the ship
	// review). Separating the lines first is what makes "the base rule exists"
	// and "the hover rule exists" separable facts.
	//
	// What is asserted about each line is that it CONTAINS the required
	// exclusions, not that it equals a fixed string. An earlier version anchored
	// the whole selector, which meant every NEW exclusion broke this file: the
	// WhatsApp phone link became the third one (`wa-phone`), and a guard that
	// fails whenever the rule is correctly extended trains people to edit the
	// guard rather than read it. Exclusions are additive by nature — the property
	// worth pinning is that these two have not been REMOVED.
	const REQUIRED = [
		// `<Button asChild>` → `<a data-slot="button">`. The first exclusion.
		'[data-slot="button"]',
		// PREFIX match, not the single `dropdown-menu-item` slot: four slots in
		// dropdown-menu.tsx accept `asChild` and can become an anchor (item,
		// checkbox-item, radio-item, sub-trigger). Naming one left the same
		// link-teal/foreground split reachable one component away (red-team review).
		'[data-slot^="dropdown-menu-"]',
	];

	/** Every whole-line `a:not(…)` selector in the stylesheet. */
	function selectorLines(): string[] {
		return [...readSource(STYLES).matchAll(/^(a:not\([^{\n]*?)\s*\{$/gm)].map(
			(m) => m[1] as string,
		);
	}

	const base = selectorLines().filter((sel) => !sel.includes(":hover"));
	const hover = selectorLines().filter((sel) => sel.includes(":hover"));

	it("has exactly one base text-link rule and one :hover rule", () => {
		// Anti-vacuity, and the thing that keeps the two assertions below
		// independent. If the extraction stops matching (a rename, a reformat that
		// wraps the selector across lines — which is how this file first broke),
		// both lists go empty and `every` passes vacuously on nothing.
		expect(
			base,
			"could not find the base (non-:hover) `a:not(...) {` text-link rule in " +
				"styles.css — if it was renamed or restructured, update this " +
				"extraction; if it was DELETED, that is the bug, not the test.",
		).toHaveLength(1);
		expect(hover).toHaveLength(1);
	});

	it.each(
		REQUIRED,
	)("the base rule still excludes %s, so those anchors keep their own color", (exclusion) => {
		expect(
			base[0],
			`the global text-link rule must exclude ${exclusion}. It is UNLAYERED, ` +
				"so it beats any layered Tailwind utility a component sets — without " +
				"the exclusion those anchors are repainted link-teal while their " +
				"non-anchor peers keep the foreground color, splitting one set of " +
				"peer actions into two apparent classes (#541, found by /qa " +
				"2026-08-10).",
		).toContain(exclusion);
	});

	it.each(REQUIRED)("the :hover rule still excludes %s", (exclusion) => {
		// The hover rule is a SEPARATE selector; excluding only the base rule
		// leaves the teal reappearing under the cursor, which reads as a
		// different kind of item exactly when the user is about to click it.
		expect(
			hover[0],
			"the :hover half of the text-link rule needs the same exclusions, or " +
				"these anchors flip to link-teal on hover.",
		).toContain(exclusion);
	});
});
