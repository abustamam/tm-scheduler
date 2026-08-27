// The global text-link rule in `styles.css` is UNLAYERED, so it beats any
// layered Tailwind utility a component sets on an anchor — the same collision
// already fixed for `<Button asChild>`, dropdown-menu items, the WhatsApp
// phone/email pair, `BackLink` and the guest-book link (see the exclusions in
// `styles.css`, and `export-menu-link-color.guard.test.ts` /
// `whatsapp-phone-link-color.guard.test.ts` / `back-link-color.guard.test.ts`).
//
// `MeetingNavStrip`'s date pills are the seventh instance and the first one on
// a FILL, which is why it was by far the worst: the active pill is
// `bg-primary text-primary-foreground`, and the rule repainted that foreground
// --lagoon-deep, landing the label on --primary in nearly the same hue.
// Measured 1.19:1 in dark (#8de5db on #60d7cf) and 1.53:1 in light (#328f97 on
// #246f76) — the date you were looking at was the one date you could not read.
// With the exclusion: 10.8:1 dark, 5.8:1 light.
//
// Both branches of the pill's `cn()` are covered by the one arm, deliberately.
// The active and inactive pills are peer items in a single strip, and the
// `wa-phone` / `wa-email` case is the precedent for not splitting a peer set:
// shipping one half of a pair in link-teal and the other in its intended
// colour is what a half-applied fix looks like.
//
// Nothing else in this repo can catch a regression here. jsdom loads no
// stylesheet, so a component test sees no colour at all; the print page-count
// harness inlines only PRINT_PAGE_CSS and never loads a screen surface;
// typecheck and lint have no view of the cascade. So this is a source grep on
// the CSS plus a check that the component's own anchor still carries the slot
// and still paints itself.
//
// COMMENT-BLIND (`readSource`) throughout: every assertion below is of the
// "this pattern must BE present" form, and this file itself quotes the
// patterns it checks for — a raw read would also pass on a commented-out rule,
// or on a component whose markup had regressed while its comments still
// described the old, correct shape. See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "../../styles.css");
const COMPONENT = resolve(HERE, "meeting-nav-strip.tsx");

/** The one exclusion this file is responsible for. The sibling link-colour
 *  guards own the others — each names only the slot its own component asked
 *  for, so a deletion points at the component that regressed. */
const SLOT = '[data-slot="meeting-nav-link"]';

describe("the unlayered text-link rule leaves the meeting date pills alone", () => {
	// Matched as WHOLE selector LINES, then split into the base rule and its
	// `:hover`, the same technique the sibling guards use and for the same
	// reason: the `:hover` selector contains the base selector as a prefix, so
	// deleting the base rule outright would otherwise leave both "found" if
	// they were matched as one blob.
	function selectorLines(): string[] {
		return [...readSource(STYLES).matchAll(/^(a:not\([^{\n]*?)\s*\{$/gm)].map(
			(m) => m[1] as string,
		);
	}

	const base = selectorLines().filter((sel) => !sel.includes(":hover"));
	const hover = selectorLines().filter((sel) => sel.includes(":hover"));

	it("has exactly one base text-link rule and one :hover rule", () => {
		// Anti-vacuity: if the extraction stops matching (a rename, or a reformat
		// that wraps the selector across lines), both lists go empty and every
		// assertion below would pass vacuously on nothing.
		expect(
			base,
			"could not find the base (non-:hover) `a:not(...) {` text-link rule in " +
				"styles.css — if it was renamed or restructured, update this " +
				"extraction; if it was DELETED, that is the bug, not the test.",
		).toHaveLength(1);
		expect(hover).toHaveLength(1);
	});

	it("the base rule excludes meeting-nav-link, so the pills keep their colour", () => {
		expect(
			base[0],
			`the global text-link rule must exclude ${SLOT}. It is UNLAYERED, so it ` +
				"beats the pill's own `text-primary-foreground` — without the " +
				"exclusion the ACTIVE date pill renders --lagoon-deep on a --primary " +
				"fill: 1.19:1 in dark mode, 1.53:1 in light, i.e. illegible.",
		).toContain(SLOT);
	});

	it("the :hover rule excludes meeting-nav-link too", () => {
		// A SEPARATE selector from the base rule; excluding only the base leaves
		// the pill flipping to link-teal's hover step the moment the pointer
		// lands on it — a regression visible only while hovering, and on the
		// active pill that flip is the illegible state coming back.
		expect(
			hover[0],
			"the :hover half of the text-link rule needs the same exclusion, or " +
				"every date pill flips to link-teal under the cursor.",
		).toContain(SLOT);
	});

	it.each([
		["base", () => base[0]],
		[":hover", () => hover[0]],
	])("every exclusion on the %s rule is a data-slot opt-out", (_which, get) => {
		// Structural, not additive: an exclusion here may only ever name a
		// `data-slot` a component deliberately stamps on itself. Appending
		// `:not([class])` (or any non-data-slot arm) would widen the exclusion to
		// every real anchor in the app — all of which carry Tailwind classes —
		// and switch the whole text-link rule off while every substring
		// assertion above stayed green.
		const selector = get();
		expect(selector).toBeTruthy();
		const arms = [...(selector as string).matchAll(/:not\(([^)]*)\)/g)].map(
			(m) => (m[1] as string).trim(),
		);
		expect(
			arms.length,
			`no :not() arms found in \`${selector}\` — the extraction has drifted ` +
				"and this assertion is checking nothing",
		).toBeGreaterThan(0);
		for (const arm of arms) {
			expect(
				arm,
				`\`:not(${arm})\` is not a [data-slot=…] opt-out. Exclusions here are ` +
					"additive and that is fine, but each must name a marker a component " +
					"asked for — an arm like `[class]` widens the exclusion past every " +
					"component and silently turns the rule off, which no `toContain` " +
					"assertion can see.",
			).toMatch(/^\[data-slot[\^$*~|]?="[^"]+"\]$/);
		}
	});

	it("the pill anchor carries the slot", () => {
		expect(
			readSource(COMPONENT),
			`${SLOT} is missing from meeting-nav-strip.tsx. Without it the ` +
				"unlayered text-link rule wins over both branches of the pill's " +
				"`cn()` and the active date reads at ~1.2:1 on its own fill.",
		).toContain('data-slot="meeting-nav-link"');
	});

	it.each([
		// Paired with the slot on purpose: the slot without a colour of its own
		// leaves the pill opted out of the site rule AND painting nothing, which
		// is a worse outcome than the bug this guards against. Both branches are
		// named, because the exclusion covers both and a peer set must not be
		// half-coloured.
		["border-primary bg-primary text-primary-foreground", "active"],
		["border-border bg-card text-muted-foreground", "inactive"],
	])("the %s pill still paints its own colour (%s)", (classes) => {
		expect(readSource(COMPONENT)).toContain(classes);
	});
});
