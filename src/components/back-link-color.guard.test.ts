// The global text-link rule in `styles.css` is UNLAYERED, so it beats any
// layered Tailwind utility a component sets on an anchor — the same
// collision already fixed for `<Button asChild>`, dropdown-menu items and
// the WhatsApp phone/email pair (see the exclusions beside `back-link` in
// `styles.css`, and `export-menu-link-color.guard.test.ts` /
// `whatsapp-phone-link-color.guard.test.ts`).
//
// `BackLink` (`back-link.tsx`) is the fifth: its two call sites — the
// per-meeting agenda editor and the roles guide — both set
// `text-muted-foreground` on a "Back to …" anchor. Without the
// `[data-slot="back-link"]` exclusion this rule overrode that down to
// --lagoon-deep (#328f97, 3.81:1 on white) at `text-sm`, under WCAG AA for
// normal text (#agenda-templates Task 11).
//
// Nothing else in this repo can catch that. jsdom loads no stylesheet, so a
// component test sees no color at all; the print page-count harness inlines
// only the PRINT stylesheet and never loads a screen surface; typecheck and
// lint have no view of the cascade. So this is a source grep on the CSS, plus
// a check that both call sites actually go through the shared component
// rather than hand-rolling a second anchor that never got the exclusion.
//
// COMMENT-BLIND (`readSource`) throughout: every assertion below is of the
// "this pattern must BE present" form, and this file itself quotes the
// patterns it checks for — a raw read would also pass on a commented-out
// rule or a component whose real markup had regressed but whose comments
// still described the old, correct shape. See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "../styles.css");
const COMPONENT = resolve(HERE, "back-link.tsx");

/** The one exclusion this file is responsible for. `export-menu-link-color`
 *  and `whatsapp-phone-link-color` own the others — each guard names only
 *  the slot(s) its own component asked for. */
const SLOT = '[data-slot="back-link"]';

describe("the unlayered text-link rule leaves BackLink's own color alone", () => {
	// Matched as WHOLE selector LINES, then split into the base rule and its
	// `:hover`, the same technique `export-menu-link-color.guard.test.ts` uses
	// and for the same reason: the `:hover` selector contains the base
	// selector as a prefix, so deleting the base rule outright would otherwise
	// leave both "found" if they were matched as one blob.
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

	it("the base rule excludes back-link, so BackLink keeps its own color", () => {
		expect(
			base[0],
			`the global text-link rule must exclude ${SLOT}. It is UNLAYERED, so it ` +
				"beats BackLink's own `text-muted-foreground` — without the exclusion " +
				'both "Back to …" links render --lagoon-deep (#328f97, 3.81:1 on ' +
				"white) at text-sm, under WCAG AA for normal text.",
		).toContain(SLOT);
	});

	it("the :hover rule excludes back-link too", () => {
		// A SEPARATE selector from the base rule; excluding only the base leaves
		// the link flipping to link-teal's hover step the moment the pointer
		// lands on it — a regression visible only while hovering.
		expect(
			hover[0],
			"the :hover half of the text-link rule needs the same exclusion, or " +
				"BackLink flips to link-teal on hover.",
		).toContain(SLOT);
	});

	it.each([
		["base", () => base[0]],
		[":hover", () => hover[0]],
	])("every exclusion on the %s rule is a data-slot opt-out", (_which, get) => {
		// Structural, not additive: an exclusion here may only ever name a
		// `data-slot` a component deliberately stamps on itself. Appending
		// `:not([class])` (or any non-data-slot arm) would widen the exclusion
		// to every real anchor in the app — all of which carry Tailwind classes
		// — and switch the whole text-link rule off while every substring
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

	it("BackLink's own anchor carries the slot and sets its own color", () => {
		const src = readSource(COMPONENT);
		expect(
			src,
			`${SLOT} is missing from back-link.tsx. Without it the unlayered ` +
				"text-link rule wins over `text-muted-foreground` and every " +
				'"Back to …" link renders at ~3.8:1 on white.',
		).toContain('data-slot="back-link"');
		// Paired on purpose: the slot without the class leaves the link with NO
		// color at all (opted out of the site rule, painted nothing itself),
		// which is a worse outcome than the bug this guards against.
		expect(src).toContain("text-muted-foreground");
	});

	it.each([
		"club.$clubId.meeting.$meetingId_.agenda.tsx",
		"club.$clubId.roles-guide.tsx",
	])("%s renders its back-link through the shared BackLink component", (file) => {
		// Guards against a future hand-rolled `<Link className="… text-muted-
		// foreground …">` reappearing at either call site — the exact shape that
		// needed the exclusion in the first place, and a shape neither the CSS
		// assertions above nor a render test (jsdom loads no stylesheet) can see
		// coming back.
		const src = readSource(resolve(HERE, "../routes", file));
		expect(
			src,
			`${file} no longer imports BackLink — if the back-link moved to a new ` +
				"component, follow it and update this guard; if it was replaced " +
				"with a hand-rolled anchor, that anchor needs its own " +
				'`data-slot="back-link"` (or a new exclusion) or it silently loses ' +
				"its color to the unlayered text-link rule again.",
		).toMatch(
			/import\s*\{\s*BackLink\s*\}\s*from\s*["']#\/components\/back-link["']/,
		);
		expect(src).toContain("<BackLink");
	});
});
