// One home for `mailto:` URL construction: `src/lib/mailto.ts`.
//
// ## Why a guard and not just a helper
//
// The helper already existed and three of four sinks used it. The fourth —
// `buildNudge`'s pre-composed VPE draft — was written the same day and read
// perfectly plausibly, because a raw template literal is what a `mailto:` URL
// looks like. Nothing failed. The commit that fixed the other three even
// claimed in its own comment that there were three.
//
// So the property worth protecting is not "these four call sites are correct"
// (a review can check that once) but "a FIFTH cannot appear" — a negative
// across a whole tree, which no behavioural test can assert. Modelled on
// `ti-wordmark.guard.test.ts` and `no-tel-links.guard.test.ts`.
//
// What is at stake is worth the file. Everything after the first `?` in a
// `mailto:` URL is HEADERS the reader's mail client honours, so a stored
// `ada@club.org?bcc=attacker@evil.com&body=I resign` interpolated raw yields a
// draft that blind-copies a third party AND replaces the app's own subject and
// body — and `members.email` / `guests.email` are not uniformly validated as
// addresses on write (`bulkImportSchema` is a bare `z.string()`), with rows
// predating any validator persisting regardless.
//
// ## Read direction
//
// RAW (`readFileSync`), deliberately NOT `#/test/guard-source`. This asserts an
// offender list is EMPTY, so blanking comments could only ever REMOVE a match —
// it would loosen the guard, never harden it. That is the rule stated once in
// `src/test/guard-source.ts`, and it is the same direction ti-wordmark and the
// `tel:` scan read in. The cost is a comment that happens to spell the forbidden
// construction verbatim would be a false offender: a false FAILURE, which a
// human sees immediately, and the safe direction for a guard.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");

/**
 * A `mailto:` scheme glued to a DYNAMIC value — the construction being confined.
 *
 * Two spellings, because those are the two a hand-written sink takes:
 *
 *   - `` `mailto:${addr}` `` — a template literal, which is what all four sinks
 *     in this repo were written as.
 *   - `"mailto:" + addr` — string concatenation.
 *
 * Deliberately NOT the bare scheme. A raw-read offender guard can only gain
 * FALSE offenders from prose, and this one would: `brand.ts` holds a fully
 * STATIC `mailto:` constant (the access-request address, no user data in it and
 * nothing to inject), several test files assert on literal `mailto:` strings,
 * and four source comments discuss the scheme by name. None of those is a sink.
 * The defect is a stored value reaching the scheme unescaped, so the pattern is
 * anchored on the interpolation, which is the defect itself.
 *
 * Honest limitation, shared with every lexical guard here: a URL assembled in
 * pieces (`const scheme = "mail" + "to:"`) escapes it. The pattern this exists
 * to stop is the one that has actually shipped four times, and that one is
 * pinned — including in the allowed home, which the live-fire check below uses
 * to prove the pattern still detects it.
 */
const RAW_MAILTO = /mailto:(?:\$\{|["'`]\s*\+)/;

/**
 * The ONE module allowed to build a `mailto:` URL from a value.
 *
 * It is the module that owns the escaping rule (`encodeURIComponent`, then
 * restore `@` alone), so its own construction is the rule rather than a bypass
 * of it. Adding a second entry here needs the same reasoning, in writing.
 */
const ALLOWED = "src/lib/mailto.ts";

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
 * `SCANNED` in that order, so the anti-vacuity count below measures the same
 * set the offender loop iterates. Counting a pre-filter list is how
 * `no-tel-links.guard.test.ts` was once able to exclude every `.tsx` file in
 * the repo and still pass its own `> 100` check.
 */
const scanned = SCAN_ROOTS.filter((r) => existsSync(resolve(ROOT, r)))
	.flatMap((r) => walk(resolve(ROOT, r)))
	// This guard states the construction it forbids, so it can't be its own
	// offender — the same self-exclusion ti-wordmark needs.
	.filter((abs) => abs !== SELF)
	.filter((abs) => SCANNED.test(abs));

/**
 * Files that MUST be in the scanned set, one per extension class.
 *
 * A count cannot see a whole class disappear: `src/` holds well over 100 `.ts`
 * files, so narrowing `SCANNED` to `/\.(m?[jt]s)$/i` would drop every `.tsx`
 * file — which is where the RENDERED `mailto:` anchors live — and still clear a
 * `> 100` check comfortably. `nudge.ts` is the `.ts` sink this guard was
 * written for; `vp-membership.tsx` renders one of the three display links.
 */
const CANARIES = [
	"src/lib/nudge.ts",
	"src/routes/_authed/admin/vp-membership.tsx",
];

describe("mailto: URLs are built in exactly one place", () => {
	const relScanned = scanned.map((abs) => relative(ROOT, abs));

	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(scanned.length).toBeGreaterThan(100);
	});

	it.each(CANARIES)("scans %s", (canary) => {
		expect(
			relScanned,
			`${canary} is not in the scanned set. A narrowed SCANNED pattern can ` +
				"drop a whole extension class while the count above still passes on " +
				"the remaining one.",
		).toContain(canary);
	});

	it("the pattern still detects the construction it forbids", () => {
		// Live fire, not a synthetic string: the ALLOWED module builds a `mailto:`
		// URL by interpolation, so it is a real, maintained example of exactly what
		// this guard hunts. If a refactor there stops matching, the regex has
		// drifted from the code shape it is aimed at and the offender list below
		// would go empty for the wrong reason — a guard that inspects nothing and
		// reports success, which is the failure mode source greps exist to avoid.
		expect(
			RAW_MAILTO.test(readFileSync(resolve(ROOT, ALLOWED), "utf8")),
			`${ALLOWED} no longer matches RAW_MAILTO. Either the helper stopped ` +
				"interpolating (update this check) or the pattern has drifted and the " +
				"scan below can no longer find a raw sink.",
		).toBe(true);
	});

	it("no module outside src/lib/mailto.ts glues a value onto the mailto: scheme", () => {
		const offenders: string[] = [];
		for (const abs of scanned) {
			const rel = relative(ROOT, abs);
			if (rel === ALLOWED) continue;
			// RAW read — see the note at the top of this file.
			if (RAW_MAILTO.test(readFileSync(abs, "utf8"))) offenders.push(rel);
		}
		expect(
			offenders,
			"These modules build a `mailto:` URL from a value themselves. " +
				"Everything after the first `?` in a mailto URL is HEADERS the " +
				"reader's mail client honours, so a stored " +
				"`a@b.com?bcc=x&body=…` silently blind-copies a third party and " +
				"rewrites the message. Use `mailtoHref` from `#/lib/mailto` for the " +
				"ADDRESS and append your own `?subject=…&body=…` after it, the way " +
				"`buildNudge` does.",
		).toEqual([]);
	});
});
