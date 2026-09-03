// Trademark guard (#495, ADR-0024 constraint 1 — "Do not induce the use.
// Toastmasters is never named in UI copy, placeholder, help text, alt text,
// onboarding, or docs for this feature."). This is the "offender list must
// be empty" shape (`ti-wordmark.guard.test.ts`, `server-modules.guard.test.ts`):
// it asserts NO user-visible string in the club-logo feature matches
// `/toastmaster/i`.
//
// DEPARTURE FROM THAT PATTERN, DELIBERATE — DO NOT "FIX" THIS BACK: every
// other empty-offender guard in this repo reads RAW source (a comment can
// only cause a false FAILURE there, so stripping would only loosen it). This
// guard reads THROUGH `#/test/guard-source` instead, and it must keep doing
// so. The offense this guard protects against is naming the mark in
// user-visible COPY, not in prose about the rule — a comment like "per
// ADR-0024, never name Toastmasters in this label" (which is, verbatim, the
// kind of comment this feature's own source carries) is not an offense.
// Reading raw source would make this guard fail against its own
// documentation, which is exactly backwards. Comment-blindness can only
// remove text here, never add a false pass, because what it strips is
// covered by the SEPARATE inline-JSX-string check below, which is
// deliberately NOT comment-blind for the same reason `ti-wordmark` isn't:
// that check's offenders are always live string literals, never comments.
//
// SCOPE, corrected twice during implementation — grep a named copy block,
// not whole files:
//   - `CLUB_LOGO_COPY` (`club-settings.tsx`), the block only. NOT the whole
//     file: it also legitimately contains "Most clubs have the Toastmaster
//     of the Day introduce the Timer" (pre-existing, geIntroducesFunctionaries
//     toggle) — nominative use of the program name, ADR-0024 decision 2,
//     unchanged. 25 files under src/routes/ and src/components/ name the
//     program for the same reason. Exempting the whole file would put the
//     hole exactly on the upload UI, the highest-risk surface.
//   - `club-logo.tsx`, the whole file. It has no legitimate reason to name
//     the program at all.
//   - NOT any `*.test.tsx` fixture: `meeting-agenda-print.test.tsx` has a
//     `roles={[{ label: "Toastmaster", … }]}` fixture — a role label in test
//     data, not shipped copy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../../..");

const CLUB_SETTINGS_FILE = "src/routes/_authed/admin/club-settings.tsx";
const CLUB_LOGO_FILE = "src/components/agenda/club-logo.tsx";

const TRADEMARK = /toastmaster/i;

/**
 * The `CLUB_LOGO_COPY` object literal's contents, brace-matched (like
 * `print-page-reset.guard.test.ts`'s `@media print` extraction) rather than
 * regex-matched up to `} as const;` — a nested `{}` inside a value would
 * otherwise end the match early. Reads through the comment-stripped source
 * first, so a doc comment sitting inside or just above the block (there is
 * one, explaining exactly this rule) can never register as an offense.
 */
function clubLogoCopyBlock(): string {
	const src = readSource(resolve(ROOT, CLUB_SETTINGS_FILE));
	const marker = "CLUB_LOGO_COPY";
	const declAt = src.indexOf(`export const ${marker} = `);
	if (declAt === -1) {
		throw new Error(
			`Could not find "export const ${marker} = " in ${CLUB_SETTINGS_FILE}. ` +
				"This guard's scope depends on that exact declaration existing.",
		);
	}
	const open = src.indexOf("{", declAt);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
	}
	throw new Error(
		`Unbalanced braces walking ${marker} in ${CLUB_SETTINGS_FILE}.`,
	);
}

describe("club-logo copy names no trademark (#495, ADR-0024 constraint 1)", () => {
	it("scans a non-trivial amount of copy (so a broken extraction can't pass vacuously)", () => {
		const block = clubLogoCopyBlock();
		// A floor on how much copy this guard actually inspected, counted by KEY
		// rather than by quoted literal. It counted `"…"` matches until #504,
		// which made three values template literals so they could interpolate the
		// shared limits — dropping the census from 19 to 16 against a floor of 10
		// while the object GREW. Counting keys tracks the object itself, so the
		// next value that stops being a plain string does not quietly erode it.
		const keys = block.match(/^\t[A-Za-z]\w*:/gm) ?? [];
		expect(
			keys.length,
			`Expected the CLUB_LOGO_COPY extraction to find most of its keys, found ${keys.length}. ` +
				"A drop here means the block extraction broke, not that the copy shrank.",
		).toBeGreaterThan(15);

		const logoComponentSrc = readSource(resolve(ROOT, CLUB_LOGO_FILE));
		expect(logoComponentSrc.length).toBeGreaterThan(200);
	});

	it("CLUB_LOGO_COPY (club-settings.tsx) contains no trademark", () => {
		const block = clubLogoCopyBlock();
		expect(
			TRADEMARK.test(block),
			"CLUB_LOGO_COPY names a trademark. Per ADR-0024 constraint 1, this " +
				'feature never names "Toastmasters" in user-visible copy — the field ' +
				'is labeled "Club logo" and stays that way.',
		).toBe(false);
	});

	it("club-logo.tsx contains no trademark", () => {
		const src = readSource(resolve(ROOT, CLUB_LOGO_FILE));
		expect(
			TRADEMARK.test(src),
			"club-logo.tsx names a trademark. Per ADR-0024 constraint 1, this " +
				"file (the shared render for a club's own uploaded logo) must never " +
				'name "Toastmasters" — in the alt text, a class name, anywhere.',
		).toBe(false);
	});

	it("club-settings.tsx as a whole is NOT scanned (nominative use elsewhere is expected)", () => {
		// Documents the scoping decision as a running assertion, not just a
		// comment: club-settings.tsx legitimately names the program outside
		// CLUB_LOGO_COPY (the geIntroducesFunctionaries copy), so whole-file
		// scanning is unimplementable, not an oversight. If this ever goes
		// false, ADR-0024 decision 2 changed and this guard's scoping should
		// be revisited too.
		const whole = readFileSync(resolve(ROOT, CLUB_SETTINGS_FILE), "utf8");
		expect(TRADEMARK.test(whole)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// No logo copy string escapes CLUB_LOGO_COPY by being inlined in JSX. An
// inlined string is invisible to every check above, because they only ever
// look INSIDE CLUB_LOGO_COPY (deliberately, not at the whole file) — so a
// future "Toastmasters"-naming string typed directly into JSX would silently
// bypass this entire guard rather than tripping it.
// ---------------------------------------------------------------------------

/**
 * The Club logo section's JSX render, anchored on stable markers rather than
 * line numbers: from the heading's `CLUB_LOGO_COPY.sectionTitle` reference
 * through the closing `</form>` of the `onSubmit={onUploadLogo}` form. Throws
 * (rather than silently scanning an empty string) if any anchor has moved,
 * so a rename can't make the check below pass vacuously.
 */
function clubLogoJsxSection(): string {
	const src = readSource(resolve(ROOT, CLUB_SETTINGS_FILE));
	const start = src.indexOf("CLUB_LOGO_COPY.sectionTitle");
	const formAt = src.indexOf("onSubmit={onUploadLogo}", start);
	const formEnd = src.indexOf("</form>", formAt);
	if (start === -1 || formAt === -1 || formEnd === -1) {
		throw new Error(
			`Could not locate the Club logo JSX section in ${CLUB_SETTINGS_FILE} — ` +
				"the anchors this guard depends on (CLUB_LOGO_COPY.sectionTitle, " +
				"onSubmit={onUploadLogo}, </form>) moved or were renamed.",
		);
	}
	return src.slice(start, formEnd + "</form>".length);
}

/**
 * Structural JSX attributes that legitimately carry a literal string in this
 * section (element ids, DOM `type`s, the file-input `accept` filter,
 * Tailwind classes, `htmlFor`, a `variant`, `data-testid`, and the
 * deliberately-empty `alt=""`). Deliberately excludes `placeholder`,
 * `aria-label`, and `title` — those legitimately carry user-visible copy, so
 * a future one appearing here should trip this check, not be allow-listed
 * away.
 */
const SAFE_ATTR =
	/\b(?:id|name|type|accept|className|htmlFor|variant|alt|data-testid)="[^"]*"/g;

/**
 * Any remaining quoted string containing a letter, after stripping the safe
 * attributes above, is copy that bypassed CLUB_LOGO_COPY — whether typed as
 * raw JSX children text or as a literal string inside a `{…}` expression
 * (e.g. one branch of a ternary), which is exactly the shape of "move a
 * value back inline instead of through the constant."
 */
function inlineStringOffenders(section: string): string[] {
	const stripped = section.replace(SAFE_ATTR, "");
	return stripped.match(/"[^"]*[A-Za-z][^"]*"/g) ?? [];
}

describe("no club-logo copy string is inlined in JSX outside CLUB_LOGO_COPY (#495)", () => {
	it("locates a non-trivial JSX section (so a broken anchor can't pass vacuously)", () => {
		const section = clubLogoJsxSection();
		expect(section.length).toBeGreaterThan(500);
	});

	it("every string in the Club logo JSX section is a structural attribute, not inlined copy", () => {
		const offenders = inlineStringOffenders(clubLogoJsxSection());
		expect(
			offenders,
			"The Club logo section has a quoted string that isn't a structural " +
				`attribute: ${JSON.stringify(offenders)}. All user-visible copy in ` +
				"this section must come from CLUB_LOGO_COPY — an inlined string is " +
				"invisible to the trademark checks above, which only scan that " +
				"constant.",
		).toEqual([]);
	});
});
