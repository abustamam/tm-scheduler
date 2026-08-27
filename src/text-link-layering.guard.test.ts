// The global text-link rule in `styles.css` must stay INSIDE `@layer base`.
//
// ## What this replaces, and why the shape changed
//
// This file supersedes four guards — `export-menu-link-color`,
// `whatsapp-phone-link-color`, `back-link-color` and
// `meeting-nav-link-color` — each of which defended one
// `:not([data-slot="…"])` arm on an UNLAYERED `a { color }` rule.
//
// That rule sat outside `@layer`, and unlayered CSS beats every layered rule
// regardless of specificity, so it won over any Tailwind colour utility a
// component set on its own anchor. The repo fixed that seven times by adding
// another opt-out arm. #646 removed the cause instead: Tailwind v4 declares
// `@layer theme, base, components, utilities`, so a rule inside `base` LOSES
// to any utility, and every component's own colour wins without an arm. All
// seven arms and their four guards were deleted with it.
//
// So the thing worth defending is no longer "is each component enrolled?" —
// enrolment is gone, a new coloured anchor just works. It is "is the rule
// still layered?", because unlayering it restores all 26 bugs at once and
// nothing else in this repo can see that happen.
//
// ## Why a source grep
//
// Nothing in-process can observe the cascade. jsdom loads no stylesheet, the
// print page-count harness inlines only `PRINT_PAGE_CSS` and never loads a
// screen surface, and `bun run test` does not parse `styles.css` as CSS at all
// — the file reaches vitest as text or not at all. Typecheck and lint have no
// view of it either. A build-time assertion would see the real cascade but
// costs a full Vite build in the suite, which no test here does; #646 ran that
// check once, by hand, at implementation time.
//
// COMMENT-BLIND (`readSource`) for the must-be-present assertion, and RAW for
// the offender sweep. That split is the rule in `src/test/guard-source.ts`:
// stripping comments prevents a false PASS on "the pattern is present" (this
// very file quotes `a {` and `@layer base`), but would LOOSEN an
// offender-list-must-be-empty check, where a comment can only cause a false
// FAILURE. Both directions are used below, deliberately.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "./styles.css");

/**
 * `.prose-gavelup a` (#310) is the ONE anchor colour rule allowed to stay
 * unlayered. It is scoped to rendered markdown rather than global, it is
 * deliberate, and it predates #646. Anything else matching the offender
 * pattern is the bug this file exists to catch.
 */
const WAIVED_UNLAYERED = [".prose-gavelup a"];

/** Slice the body of the top-level `@layer base { … }` block, brace-aware. */
function layerBaseBody(source: string): string {
	const start = source.indexOf("@layer base {");
	if (start === -1) return "";
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	return "";
}

describe("the global text-link rule is layered, so utilities beat it", () => {
	it("styles.css declares an @layer base block", () => {
		// Anti-vacuity: every assertion below reads this block, so if the
		// extraction stops matching they would all pass on an empty string.
		const body = layerBaseBody(readSource(STYLES));
		expect(
			body,
			"could not find a top-level `@layer base {` block in styles.css. If it " +
				"was renamed or restructured, update this extraction; if the anchor " +
				"rule was moved OUT of it, that is the bug this file exists to catch.",
		).not.toBe("");
		expect(body.length).toBeGreaterThan(50);
	});

	it.each([
		["base", /(^|\s)a\s*(,[^{]*)?\{/],
		[":hover", /(^|\s)a:hover\s*(,[^{]*)?\{/],
	])("the %s anchor rule lives inside @layer base", (_which, pattern) => {
		// Both halves matter and they are separate selectors. Layering only the
		// base rule would leave `a:hover` unlayered, so every anchor in the app
		// would snap to link-teal under the cursor — the pre-#646 bug, visible
		// only while hovering.
		expect(
			layerBaseBody(readSource(STYLES)),
			`the \`a${_which === ":hover" ? ":hover" : ""}\` colour rule must be ` +
				"inside `@layer base`. Outside a layer it beats every Tailwind " +
				"colour utility regardless of specificity, which is what made 26 " +
				"anchors render --lagoon-deep instead of the colour they set (#646).",
		).toMatch(pattern);
	});

	it("no UNLAYERED bare-anchor colour rule exists anywhere in styles.css", () => {
		// RAW read, not comment-blind: this is an offender-list-must-be-empty
		// assertion, so stripping comments could only hide a real offender —
		// see the file header. The cost is that a commented-out rule can fail
		// this; that is the safe direction, and the message says so.
		//
		// This is the assertion that actually ends the bug class. The seven
		// prior bugs all had the same shape: a bare `a` colour rule at top
		// level. Re-adding one restores every one of them at once.
		const raw = readFileSync(STYLES, "utf8");
		const base = layerBaseBody(raw);
		const outside = base ? raw.replace(base, "") : raw;

		const offenders = [...outside.matchAll(/^([^\s@}{][^{\n]*)\{([^}]*)\}/gm)]
			.filter(([, selector, body]) => {
				const sel = (selector as string).trim();
				if (!/(^|[\s,>+~])a(?![\w-])/.test(sel)) return false;
				if (WAIVED_UNLAYERED.some((w) => sel.includes(w))) return false;
				return /(^|[\s;])color\s*:/.test(body as string);
			})
			.map(([, selector]) => (selector as string).trim());

		expect(
			offenders,
			`unlayered anchor colour rule(s) found in styles.css: ${offenders.join(
				" | ",
			)}. An unlayered rule beats every layered Tailwind utility, so this ` +
				"reopens the whole #646 bug class at once — 26 anchors silently " +
				"rendering a colour they did not ask for, invisible to every other " +
				"gate in this repo. Put the rule inside `@layer base` instead. If it " +
				"genuinely must be unlayered and scoped (like `.prose-gavelup a`), " +
				"add it to WAIVED_UNLAYERED with a reason.",
		).toEqual([]);
	});

	it("the layered anchor rule carries no !important", () => {
		// `!important` inside @layer base would beat utilities again and undo
		// the fix while every assertion above stayed green — the rule would
		// still be in the right block, and still win the wrong way.
		const body = layerBaseBody(readSource(STYLES));
		const anchorRules = [...body.matchAll(/(^|\s)a(:hover)?\s*\{([^}]*)\}/g)];
		expect(
			anchorRules.length,
			"no anchor rules found inside @layer base — extraction has drifted",
		).toBeGreaterThan(0);
		for (const [, , , decls] of anchorRules) {
			expect(
				decls as string,
				"`!important` on the layered anchor rule defeats the point of " +
					"layering it: it would beat component colour utilities again, " +
					"reopening #646 with this guard still green.",
			).not.toMatch(/!\s*important/);
		}
	});

	it("the opt-out arms are gone, not merely emptied", () => {
		// The five bespoke data-slots (wa-phone, wa-email, back-link,
		// guest-book-link, meeting-nav-link) deliberately SURVIVE on their
		// components as test selectors — three non-colour suites assert them.
		// What must not survive is a `:not([data-slot=…])` arm on an anchor
		// selector here, because that is the opt-out mechanism #646 removed and
		// its presence would mean someone is re-enrolling components by hand.
		const raw = readFileSync(STYLES, "utf8");
		const armed = [
			...raw.matchAll(/^[^\n@}{]*\ba(?![\w-])[^{\n]*:not\([^{\n]*\{/gm),
		].map((m) => (m[0] as string).trim());
		expect(
			armed,
			`anchor selector(s) with :not() opt-out arms found: ${armed.join(" | ")}. ` +
				"#646 deleted these because layering makes them unnecessary — a " +
				"component's own utility already wins. Re-adding one means the rule " +
				"is beating utilities again, which is the bug, not the fix.",
		).toEqual([]);
	});
});
