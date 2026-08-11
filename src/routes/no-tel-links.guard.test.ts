// Enforces the WhatsApp-over-dialer decision (spec 2026-08-10): no rendered
// phone number links to `tel:`. Nobody reaches for the dialer from a roster
// screen; someone who wants to call copies the number into their own phone app.
// Phone numbers render through `WhatsAppPhoneLink` instead.
//
// A source-grep guard because the change is a NEGATIVE — "this scheme is not
// used" — which no behavioural test can assert across a whole tree. Modelled on
// `ti-wordmark.guard.test.ts`.
//
// ## This file reads source BOTH ways, on purpose
//
// That looks like an inconsistency until you know the rule in
// `src/test/guard-source.ts`, so it is stated here once:
//
//   - The `tel:` scan below asserts an OFFENDER LIST IS EMPTY, so it reads RAW.
//     A comment can only ever ADD a false offender there; blanking comments
//     would LOOSEN the guard rather than harden it.
//   - The route-wiring block at the bottom asserts a PATTERN MUST BE PRESENT, so
//     it reads comment-blind through `readSource`. A comment merely quoting
//     `name={member.name}` would satisfy a raw read while the real JSX was gone —
//     a false PASS, which is a real bypass.
//
// Same file, opposite directions, because the two assertions have opposite
// failure modes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");

/**
 * A `tel:` URL bound to an href — the thing being forbidden.
 *
 * Anchored on `href=` rather than on the bare scheme. A raw-read offender guard
 * can only ever gain FALSE offenders from prose, and this one would: two
 * innocent files name `tel:` today — `whatsapp-phone-link.tsx`'s doc comment
 * ("WhatsApp, not `tel:`") and `season-grid.test.tsx`'s
 * `expect(href).not.toContain("tel:")` assertion. Both are this decision being
 * upheld somewhere else, so matching the bare scheme would fail on a clean tree.
 *
 * The optional `{` covers every JSX spelling of the same link —
 * `href="tel:…"`, `href={"tel:…"}`, `href={'tel:…'}`, `href={`tel:${x}`}`.
 *
 * Honest limitation: a scheme assembled at runtime (`const h = "tel:" + x`)
 * escapes this, as it escapes every lexical guard. The pattern this exists to
 * stop is the literal anchor that Tasks 6 and 7 removed, and that one is pinned.
 */
const TEL_LINK = /href=\s*\{?\s*["'`]tel:/;

/**
 * `src/` only. The `extension/` tree is a Base Camp scraper with no member
 * contact in it, and it ships as its own package with its own vitest config.
 */
const SCAN_ROOTS = ["src"];
const SKIP_DIRS = new Set([
	"node_modules",
	".output",
	".vite",
	"dist",
	"build",
]);
const SCANNED = /\.(m?[jt]sx?)$/i;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

/**
 * The files this guard ACTUALLY reads — walked, self-excluded, and filtered by
 * `SCANNED`, in that order.
 *
 * The extension filter has to be applied HERE, not inside the loop. It used to
 * run at the point of reading while the anti-vacuity count below measured the
 * PRE-filter list — so narrowing `SCANNED` from `/\.(m?[jt]sx?)$/i` to
 * `/\.(m?[jt]s)$/i` excluded every `.tsx` file in the repo, which is where every
 * rendered phone number lives, and left the whole suite green with a live `tel:`
 * link in `roster.tsx`. Demonstrated. An anti-vacuity assertion that counts a
 * different set from the one the test iterates is not an anti-vacuity assertion.
 */
const scanned = SCAN_ROOTS.filter((r) => existsSync(resolve(ROOT, r)))
	.flatMap((r) => walk(resolve(ROOT, r)))
	// This guard states the pattern it forbids, so it can't be its own offender.
	.filter((abs) => abs !== SELF)
	.filter((abs) => SCANNED.test(abs));

/**
 * A file that MUST be in the scanned set, named explicitly.
 *
 * A count cannot see a whole extension CLASS disappear: `src/` holds well over
 * 100 `.ts` files, so dropping every `.tsx` still clears a `> 100` check
 * comfortably. This names a `.tsx` route that renders a phone number, so the
 * class the rule exists to protect cannot be silently excluded.
 */
const CANARY = "src/routes/_authed/roster.tsx";

describe("no tel: links — phone numbers open WhatsApp", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(scanned.length).toBeGreaterThan(100);
	});

	it("scans the .tsx routes, where every rendered phone number lives", () => {
		expect(
			scanned.map((abs) => relative(ROOT, abs)),
			`${CANARY} is not in the scanned set. A narrowed SCANNED pattern can ` +
				"drop every .tsx file — the ones that actually render phone numbers " +
				"— while the count above still passes on .ts files alone.",
		).toContain(CANARY);
	});

	it("no source file links a phone number with the tel: scheme", () => {
		const offenders: string[] = [];
		for (const abs of scanned) {
			// Deliberately NOT `#/test/guard-source` (which blanks comments). This
			// asserts an offender list is EMPTY, so a comment can only ever add a
			// false offender — stripping would LOOSEN the guard, not harden it. That
			// is the opposite direction from the wiring block below.
			if (TEL_LINK.test(readFileSync(abs, "utf8"))) {
				offenders.push(relative(ROOT, abs));
			}
		}
		expect(
			offenders,
			"These files link a phone number with `tel:`. Phone numbers render " +
				"through `WhatsAppPhoneLink` — see " +
				"docs/superpowers/specs/2026-08-10-whatsapp-phone-links-design.md.",
		).toEqual([]);
	});
});

/**
 * The prop EXPRESSIONS at every call site that renders the component.
 *
 * This is the #319 trap: a component tested through its props cannot see a
 * WRONG prop, because the props are the fixture. `WhatsAppPhoneLink` is
 * thoroughly covered, and `name` at each call site is a computed expression, so
 * swapping `member.name` for the club name — or `member.phone` for
 * `member.email` — would ship past that whole suite.
 *
 * `members.$id.tsx` and `vp-membership.tsx` also mount in jsdom over stubbed
 * loader data — `members.$id.test.tsx` and `vp-membership.test.tsx` each render
 * `Route.options.component` and observe the rendered href and title — so for
 * those two this guard is a cheap second net rather than the only reader. It
 * still earns its place there: a render test sees the RESULT and would pass on
 * `name={member.preferredName ?? member.name}` or any other expression that
 * happens to produce the same string for its fixture; the grep pins the
 * EXPRESSION and fails in review. Both suites point back here by name.
 *
 * ## Why the list is FOUR entries
 *
 * It was two, and the two it omitted were `roster.tsx` — named as the CANARY
 * three lines above this block, i.e. the one file this guard already insists
 * must be scanned — and `season-grid.tsx`. A list that enumerates half the call
 * sites is worse than no list: it reads as complete. The rule is that every
 * `<WhatsAppPhoneLink>` in the tree appears here, and a new one that does not is
 * a wiring expression nothing reads.
 *
 * `season-grid.tsx` is a component rather than a route, so its path is not under
 * `_authed/`; it is in this list all the same, because what makes a call site
 * belong here is that it computes props, not where it lives.
 *
 * Read comment-blind via `readSource` — see the note at the top of this file.
 */
describe("call-site wiring for WhatsAppPhoneLink", () => {
	it.each([
		["src/routes/_authed/members.$id.tsx", "member.phone", "member.name"],
		["src/routes/_authed/admin/vp-membership.tsx", "guest.phone", "guest.name"],
		["src/routes/_authed/roster.tsx", "m.phone", "m.name"],
		["src/components/club/season-grid.tsx", "contact?.phone", "row.label"],
	])("%s passes the right phone and name", (file, phoneExpr, nameExpr) => {
		const src = readSource(resolve(ROOT, file));
		expect(src, `${file} no longer renders <WhatsAppPhoneLink`).toContain(
			"<WhatsAppPhoneLink",
		);
		expect(src, `${file} must pass phone={${phoneExpr}}`).toContain(
			`phone={${phoneExpr}}`,
		);
		expect(src, `${file} must pass name={${nameExpr}}`).toContain(
			`name={${nameExpr}}`,
		);
	});
});
