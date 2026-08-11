// @vitest-environment jsdom
/**
 * The Contact pair's colour is a TWO-FILE fix, twice over. This guard fails if
 * any half is edited away.
 *
 * `styles.css` carries an UNLAYERED `a:not(…) { color: var(--lagoon-deep) }`
 * rule. Unlayered CSS beats anything Tailwind emits into `@layer utilities`, so
 * a `text-primary` on an anchor is dead unless that anchor also carries a
 * `data-slot` and BOTH rules exclude it. The colour that actually rendered
 * before the exclusion was `--lagoon-deep` — #328f97, 3.81:1 on white — at
 * `text-xs`, i.e. below WCAG AA 4.5:1 on the roster and the sign-up sheet, the
 * two surfaces that show these links most.
 *
 * ## Why the EMAIL anchor is in here too
 *
 * The first version of this fix pinned only `wa-phone`, and the email anchor
 * sits on the same row on all three surfaces — the sign-up sheet's Contact
 * column, the member profile header, the VP-Membership guest card. It is an
 * anchor, so it took the same rule down to the same 3.81:1 at the same 12px,
 * beside a phone link now at --lagoon-ink (5.82:1). Two peer actions on one row
 * in two different colours, one of them failing AA — and the `text-primary` the
 * sign-up sheet already passed on that anchor was provably dead code. "These two
 * agree" is the property, and neither half alone can state it, so both are
 * pinned here in one file.
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
 * The email half of the same Contact pair.
 *
 * `wa-phone` alone was a HALF fix. The `mailtoHref` anchor sits on the same row
 * as the phone link on all three surfaces, it is an anchor too, and it took the
 * same unlayered rule down to --lagoon-deep (#328f97, 3.81:1) at the same 12px
 * — so the pair shipped in two different colours with one of them below AA, and
 * the `text-primary` the sign-up sheet already passed on it was provably dead
 * code. Both halves are pinned here, together, because "these two agree" is the
 * property and neither one alone states it.
 */
const EMAIL_SLOT = 'data-slot="wa-email"';

/**
 * The three call sites that render the email half, and the two things each must
 * carry on that anchor.
 *
 * Enumerated rather than discovered, and that is a known limitation: a FOURTH
 * surface rendering `mailtoHref` would not be checked here. `mailto.guard.test.ts`
 * is what makes such a surface visible at all (it fails on a mailto: URL built
 * anywhere but `lib/mailto.ts`), and adding it here is then a one-line edit in a
 * file the author is already reading.
 */
const EMAIL_CALL_SITES = [
	"club/season-grid.tsx",
	"../routes/_authed/members.$id.tsx",
	"../routes/_authed/admin/vp-membership.tsx",
];

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

/**
 * Every `:not(…)` arm of a selector, in source order.
 *
 * Arms cannot nest here (`[^)]`), which is true of every exclusion this rule
 * has ever carried and is what keeps the extraction a one-liner. A future arm
 * that did nest — `:not(:is(a, b))` — would extract short and fail the shape
 * assertion below, which is a false FAILURE and the safe direction.
 */
function notArms(selector: string): string[] {
	return [...selector.matchAll(/:not\(([^)]*)\)/g)].map((m) =>
		(m[1] as string).trim(),
	);
}

/**
 * The only shape an exclusion on this rule is allowed to take: a `data-slot`
 * ATTRIBUTE selector, exact or prefix.
 *
 * This is the structural half of the "the rule still does its job" control
 * below, and it exists because a control specimen can be unrepresentative
 * without anyone noticing. Appending `:not([class])` to both rules turned the
 * link-teal rule off for every real anchor in the app — all of which carry
 * Tailwind classes — while every guard stayed green, because the control
 * anchors were bare. Demonstrated at 12/12.
 *
 * A control can only ever say "this ONE specimen still matches"; this says
 * "the exclusions can only ever be opt-outs a component asked for", which is
 * the actual contract. `data-slot` is a deliberate, greppable marker a
 * component puts on itself — `[class]`, `[href^="/"]` or a tag arm are not.
 */
const DATA_SLOT_ARM = /^\[data-slot[\^$*~|]?="[^"]+"\]$/;

describe("the Contact pair's colour survives the unlayered anchor rule", () => {
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
			for (const slot of [SLOT, EMAIL_SLOT]) {
				expect(
					rule.replace(/\s+/g, ""),
					`This unlayered rule does not exclude [${slot}], so it overrides ` +
						"that anchor's `text-primary` down to --lagoon-deep (#328f97, " +
						"3.81:1 on white, below AA at the 12px these surfaces use). Both " +
						"slots or neither: the phone and the email are peer actions on " +
						"one row, and excluding one is what shipped the pair in two " +
						"colours. Fix it with another `:not()` — a class cannot beat an " +
						"unlayered rule.",
				).toContain(`[${slot}]`);
			}
		}
	});

	it("every exclusion is a data-slot opt-out, not a blanket escape", () => {
		// The structural complement to the "an ordinary link still matches" control
		// below, and strictly stronger than it. A control can only report on the
		// ONE specimen it builds: appending `:not([class])` to both rules turned
		// this rule off for every real anchor in the app — all of which carry
		// Tailwind classes — and left all three CSS guards green at 12/12, because
		// every control anchor was bare. Demonstrated.
		//
		// This asks the property directly instead: an exclusion may only ever name
		// a `data-slot` a component deliberately put on itself. `[class]`,
		// `[href^="/"]`, `.something` and a bare tag arm all fail here regardless of
		// what any control specimen happens to look like.
		const rules = styles.match(ANCHOR_RULES) ?? [];
		expect(rules).toHaveLength(2);

		for (const rule of rules) {
			const selector = rule.replace(/\s*\{$/, "").trim();
			const arms = notArms(selector);
			// Anti-vacuity: an extraction that matched nothing would pass the loop
			// below on an empty list, which is the failure mode this whole file
			// exists to avoid. Deliberately `> 0` and not "at least the four we ship
			// today" — WHICH exclusions must be present is the assertion above's
			// job, stated with a message that names the missing slot; duplicating it
			// as a count here would fail the same regression with "expected 3 to be
			// >= 4", which tells the reader nothing about what was removed.
			expect(
				arms.length,
				`no :not() arms found in \`${selector}\` — the extraction has drifted ` +
					"and this assertion is checking nothing",
			).toBeGreaterThan(0);

			for (const arm of arms) {
				expect(
					arm,
					`\`:not(${arm})\` in \`${selector}\` is not a [data-slot=…] ` +
						"opt-out. Exclusions on this rule are additive and that is fine, " +
						"but every one must name a marker a component asked for. An arm " +
						"like `[class]` or a tag/class selector widens the exclusion far " +
						"past any component and silently switches the whole text-link " +
						"rule off, which no substring assertion and no bare control " +
						"anchor can see.",
				).toMatch(DATA_SLOT_ARM);
			}
		}
	});

	it.each(
		EMAIL_CALL_SITES,
	)("%s stamps the email anchor with the slot AND the colour it protects", (file) => {
		// Comment-blind: these are "must BE present" assertions, and the call
		// sites' own comments quote `data-slot="wa-email"` and `text-primary`
		// while explaining why they are there — a raw read would pass on a file
		// that had lost the real attributes and kept the prose.
		//
		// Both halves, because either alone is worse than useless. The slot
		// without the colour opts the anchor out of the site rule and gives it
		// nothing back (it inherits the muted row colour, at a WORSE ratio than
		// the bug); the colour without the slot is dead code, which is exactly
		// what `season-grid.tsx` already shipped.
		const src = readSource(resolve(HERE, file));
		const anchors = [...src.matchAll(/<a\b[^>]*>/g)]
			.map((m) => m[0] as string)
			.filter((tag) => tag.includes("mailtoHref("));

		expect(
			anchors.length,
			`${file} no longer renders an <a href={mailtoHref(…)}> — if the ` +
				"anchor moved, follow it; if it was deleted, drop this entry.",
		).toBe(1);
		const tag = anchors[0] as string;
		expect(tag, `${file}'s email anchor must carry ${EMAIL_SLOT}`).toContain(
			EMAIL_SLOT,
		);
		expect(
			tag,
			`${file}'s email anchor must set text-primary — the slot only opts it ` +
				"out of the site rule, it does not colour it.",
		).toContain("text-primary");
	});

	it("neither rule SELECTS either half of the Contact pair, as a real selector", () => {
		// Stronger than the substring check above, and worth both: `toContain`
		// passes on a selector that is present but wrong — a stray space in
		// `[data-slot="wa-phone "]`, or an exclusion nested somewhere it does not
		// apply — while this asks the engine the actual question. Same technique as
		// `dropdown-menu.test.tsx`, which pins the same rule for menu items.
		const rules = styles.match(ANCHOR_RULES) ?? [];
		const selectors = rules.map((r) => r.replace(/\s*\{$/, "").trim());
		expect(selectors).toHaveLength(2);

		// Both halves, each built the way its call site builds it — WITH the
		// Tailwind class attribute they really carry, so a `:not([class])`-shaped
		// exclusion cannot spare them here while abandoning them in the app.
		const link = document.createElement("a");
		link.setAttribute("href", "https://wa.me/14155552671");
		link.setAttribute("data-slot", "wa-phone");
		link.setAttribute("class", "inline-flex items-center gap-1.5 text-primary");
		const email = document.createElement("a");
		email.setAttribute("href", "mailto:ada@example.com");
		email.setAttribute("data-slot", "wa-email");
		email.setAttribute("class", "text-primary hover:underline");
		document.body.append(link, email);
		try {
			for (const selector of selectors) {
				for (const half of [link, email]) {
					expect(
						half.matches(selector),
						`the shipped rule \`${selector}\` still selects the ` +
							`[data-slot="${half.getAttribute("data-slot")}"] anchor, so it ` +
							"overrides its `text-primary` down to --lagoon-deep (#328f97, " +
							"3.81:1 on white, below AA at 12px).",
					).toBe(false);
				}
			}

			// The rule must still do its JOB — an exclusion broad enough to spare
			// every anchor would pass everything above while silently un-styling
			// every text link in the app.
			const ordinary = document.createElement("a");
			ordinary.setAttribute("href", "/resources");
			// The control anchor carries a CLASS, and that is load-bearing. It was
			// a bare `<a href="/resources">` first, which made the control weaker
			// than the app it stands in for: essentially every anchor in this
			// codebase is a Tailwind component and carries a `class` attribute, so
			// `:not([class])` appended to both rules left this control matching, all
			// three CSS guards green (12/12), and the link-teal rule styling nothing
			// at all. Demonstrated. A control has to be representative, or it only
			// proves the rule still matches specimens that do not exist. The
			// `:not()`-arm shape assertion below closes the same hole from the other
			// side, and is the one that survives a future control drifting again.
			ordinary.setAttribute("class", "hover:underline");
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
