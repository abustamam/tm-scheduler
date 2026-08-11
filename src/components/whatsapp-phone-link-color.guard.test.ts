// @vitest-environment jsdom
/**
 * The WhatsApp phone link's colour is a TWO-FILE fix. This guard fails if either
 * half is edited away.
 *
 * `styles.css` carries an UNLAYERED `a:not(…) { color: var(--lagoon-deep) }`
 * rule. Unlayered CSS beats anything Tailwind emits into `@layer utilities`, so
 * the `text-primary` on `WhatsAppPhoneLink`'s anchor is dead unless the anchor
 * also carries `data-slot="wa-phone"` and BOTH rules exclude it. The colour that
 * actually rendered before the exclusion was `--lagoon-deep` — #328f97, ~3.8:1
 * on white — at `text-xs`, i.e. below WCAG AA 4.5:1 on the roster and the
 * sign-up sheet, the two surfaces that show the link most.
 *
 * ## Why a guard and not a render test
 *
 * `whatsapp-phone-link.test.tsx` already asserts the anchor's class list and its
 * `data-slot`. It cannot go further: jsdom applies no stylesheet and computes no
 * cascade, so the CASCADE — the only thing that was ever wrong here — is
 * invisible to it. The class and the attribute can both be present and correct
 * while `styles.css` overrides them, which is exactly the state this branch
 * shipped in. The same blind spot the repo already documents for print CSS.
 *
 * The failure is also silent and repeat-prone: this is the THIRD anchor to need
 * the exclusion (`<Button asChild>`, then dropdown items, now this), each found
 * by eye after shipping, and the fix has never once been a class.
 *
 * ## Read direction
 *
 * Comment-blind (`readSource`) for the TSX: these are "this pattern must BE
 * present" assertions, and the file's own comments quote `data-slot="wa-phone"`
 * several times, so a raw read would pass on a component whose anchor had lost
 * the attribute entirely. `styles.css` is read raw — `stripComments` is a JS/TS
 * lexer and CSS `/* … *\/` happens to fall in the same shape, but the CSS
 * assertions below are anchored on selector text that no comment here reproduces
 * verbatim, and a false failure is the safe direction anyway.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = resolve(HERE, "whatsapp-phone-link.tsx");
const STYLES = resolve(HERE, "../styles.css");

/** The opt-out marker, as it must appear on the anchor. */
const SLOT = 'data-slot="wa-phone"';

/**
 * The two unlayered anchor rules, matched from `a:not(` up to the `{` that opens
 * the declaration block. Whitespace-insensitive, because Biome does not format
 * `styles.css` (it is excluded) but a future Prettier/stylelint pass could
 * re-wrap a long selector across lines — and this guard must survive that
 * without survivable meaning "matches nothing".
 *
 * The `:hover` rule is a SEPARATE selector, so it needs its own exclusion; the
 * first version of this fix updated only the base rule, which left the link
 * changing colour to --lagoon-deep's hover step on hover — a regression visible
 * only while the pointer is on it.
 */
const ANCHOR_RULES = /a:not\(\s*\[data-slot="button"\][\s\S]*?\{/g;

describe("WhatsAppPhoneLink colour survives the unlayered anchor rule", () => {
	const component = readSource(COMPONENT);
	const styles = readFileSync(STYLES, "utf8");

	it("the anchor carries the data-slot that opts it out", () => {
		expect(
			component,
			`${SLOT} is missing from whatsapp-phone-link.tsx. Without it the ` +
				"unlayered `a { color: var(--lagoon-deep) }` rule in styles.css wins " +
				"over the anchor's `text-primary` and the link renders at ~3.8:1 on " +
				"white — below WCAG AA at the 12px these surfaces use.",
		).toContain(SLOT);
	});

	it("the anchor sets its own colour, rather than expecting one from a caller", () => {
		// Paired with the assertion above on purpose: the attribute without the
		// class leaves the link with NO colour at all (it opted out of the site
		// rule and set nothing), which is a worse outcome than the bug. The two
		// only make sense together.
		expect(component).toContain("text-primary");
	});

	it("both unlayered anchor rules exclude it", () => {
		const rules = styles.match(ANCHOR_RULES) ?? [];
		// Anti-vacuity: two rules, the base and its `:hover`. A selector rename or a
		// reformat that broke the pattern would otherwise leave this suite green
		// with zero rules inspected — the failure mode that makes a source guard
		// worthless.
		expect(
			rules.length,
			'expected to find the base `a:not([data-slot="button"])…` rule and its ' +
				":hover in styles.css — the pattern this guard matches on has moved, " +
				"so it is no longer checking anything",
		).toBe(2);
		expect(rules.some((r) => r.includes(":hover"))).toBe(true);

		for (const rule of rules) {
			expect(
				rule.replace(/\s+/g, ""),
				'This unlayered rule does not exclude [data-slot="wa-phone"], so it ' +
					"overrides WhatsAppPhoneLink's `text-primary` down to " +
					"--lagoon-deep (~3.8:1 on white, below AA at 12px). Fix it with " +
					"another `:not()` — a class cannot beat an unlayered rule.",
			).toContain('[data-slot="wa-phone"]');
		}
	});

	it("neither rule SELECTS the anchor, evaluated as a real selector", () => {
		// Stronger than the substring check above, and worth both: `toContain`
		// passes on a selector that is present but wrong — a stray space in
		// `[data-slot="wa-phone "]`, or an exclusion nested somewhere it does not
		// apply — while this asks the engine the actual question. Same technique as
		// `dropdown-menu.test.tsx`, which pins the same rule for menu items.
		const rules = styles.match(ANCHOR_RULES) ?? [];
		const selectors = rules.map((r) => r.replace(/\s*\{$/, "").trim());
		expect(selectors).toHaveLength(2);

		const link = document.createElement("a");
		link.setAttribute("href", "https://wa.me/14155552671");
		link.setAttribute("data-slot", "wa-phone");
		document.body.appendChild(link);
		try {
			for (const selector of selectors) {
				expect(
					link.matches(selector),
					`the shipped rule \`${selector}\` still selects the WhatsApp phone ` +
						"anchor, so it overrides its `text-primary` down to " +
						"--lagoon-deep (~3.8:1 on white, below AA at 12px).",
				).toBe(false);
			}

			// The rule must still do its JOB — an exclusion broad enough to spare
			// every anchor would pass everything above while silently un-styling
			// every text link in the app.
			const ordinary = document.createElement("a");
			ordinary.setAttribute("href", "/resources");
			document.body.appendChild(ordinary);
			for (const selector of selectors) {
				expect(
					ordinary.matches(selector.replace(/:hover$/, "")),
					`\`${selector}\` no longer selects an ordinary text link — the ` +
						"exclusion has been widened until the rule styles nothing.",
				).toBe(true);
			}
		} finally {
			document.body.innerHTML = "";
		}
	});
});
