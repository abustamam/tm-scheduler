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

const sourceFiles = SCAN_ROOTS.filter((r) => existsSync(resolve(ROOT, r)))
	.flatMap((r) => walk(resolve(ROOT, r)))
	// This guard states the pattern it forbids, so it can't be its own offender.
	.filter((abs) => abs !== SELF);

describe("no tel: links — phone numbers open WhatsApp", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it("no source file links a phone number with the tel: scheme", () => {
		const offenders: string[] = [];
		for (const abs of sourceFiles) {
			if (!SCANNED.test(abs)) continue;
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
 * The prop EXPRESSIONS at the two route call sites.
 *
 * This is the #319 trap: a component tested through its props cannot see a
 * WRONG prop, because the props are the fixture. `WhatsAppPhoneLink` is
 * thoroughly covered, and `name` at each call site is a computed expression, so
 * swapping `member.name` for the club name — or `member.phone` for
 * `member.email` — would ship past that whole suite.
 *
 * The coverage on the two sites is not equal, which is why both are pinned here:
 *
 *   - `members.$id.tsx` has NO render test at all. This guard is the only thing
 *     that sees its wiring.
 *   - `admin/vp-membership.tsx` does mount in jsdom (`vp-membership.test.tsx`
 *     renders `Route.options.component` over stubbed loader data) and that suite
 *     does observe the rendered href and title. The pin here is a cheap second
 *     net, and `vp-membership.test.tsx`'s own header points at it by name.
 *
 * Read comment-blind via `readSource` — see the note at the top of this file.
 */
describe("route wiring for WhatsAppPhoneLink", () => {
	it.each([
		["src/routes/_authed/members.$id.tsx", "member.phone", "member.name"],
		["src/routes/_authed/admin/vp-membership.tsx", "guest.phone", "guest.name"],
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
