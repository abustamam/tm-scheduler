/**
 * Every absolute millisecond bound in the render-cost bench must be at
 * CATASTROPHE scale (#641).
 *
 * ## Why a guard and not a comment
 *
 * `meeting-template-limits.bench.test.ts` had already worked this out. Its
 * docblock argues at length that a shared CI runner has no upper bound on how
 * slow it can be, so no absolute millisecond number is both loose enough never
 * to flake and tight enough to catch a modest regression; that sensitivity has
 * to come from RATIOS measured in the same process, where machine speed divides
 * out. #631 acted on that, deleted a ladder of literals, and wrote — twice, in
 * a docblock and again at the assertion — that the one remaining 2000ms bound
 * was "the ONLY absolute bound now".
 *
 * It was not. Two others were left standing, 250ms and 150ms, both sized well
 * inside the 331ms of pure runner variance that same docblock records as
 * observed. On 2026-08-26 the 250ms one measured 288.81ms on CI and reddened
 * `main` on a commit that touched none of this code.
 *
 * So the failure was not the reasoning — the reasoning was right and written
 * down. The failure is that a stated invariant nothing CHECKS decays silently,
 * and worse, the statement that it held is exactly what stopped anyone
 * re-deriving it. A comment saying "this is the only one" is indistinguishable,
 * to every future reader, from a comment saying "this was the only one when I
 * wrote this". This file is the difference.
 *
 * ## Read RAW, not comment-blind
 *
 * This is an offender sweep — "no bound below the floor may exist" — so per
 * `guard-source.ts`, stripping comments would LOOSEN it in the wrong direction
 * only if comments could hide an offender, which they cannot: a bound inside a
 * comment is not executed. Reading raw can only produce a false FAILURE (a
 * commented-out `expect(ms).toBeLessThan(150)` would trip it), which is the
 * safe direction and, if it ever happens, is a prompt to delete dead code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BENCH = "src/lib/meeting-template-limits.bench.test.ts";

/**
 * The worst single measurement of pure runner variance recorded on this repo's
 * CI: the 200-beat ceiling workload at 331ms, on an unrelated PR, with the
 * IDENTICAL commit passing on a re-run minutes later. Same commit red then
 * green is proof of variance rather than a diagnosis of it.
 *
 * This is an OBSERVATION, not a tuning knob. Lowering it to make the floor
 * below permissive would be falsifying a recorded measurement rather than
 * adjusting a threshold — which is the point of deriving one from the other.
 */
const WORST_OBSERVED_CI_VARIANCE_MS = 331;

/**
 * The floor an absolute bound in that file must clear.
 *
 * 3x the worst observed variance. Stated as a MULTIPLE of a recorded
 * measurement rather than as a literal, because a literal floor is the same
 * kind of number this guard exists to police: pick it by hand and the next
 * person raises it by hand.
 */
const MIN_ABSOLUTE_MS_BOUND = 3 * WORST_OBSERVED_CI_VARIANCE_MS;

/**
 * An assertion on a millisecond-valued expression, capturing its bound.
 *
 * Matches `expect(ms)`, `expect(emojiMs)`, `expect(asciiMs)` — an identifier
 * (or dotted path) whose last segment is `ms` or ends in `Ms`, case-sensitively
 * so `msPerRow` does NOT match. That exclusion is deliberate and load-bearing:
 * `msPerRow` ratios are the file's machine-independent half and are SUPPOSED to
 * carry small bounds like 3. A pattern that swept them in would demand they be
 * ≥993 and destroy the very mechanism this guard protects.
 *
 * `[^)/]*` before the close paren keeps a DIVISION out: `expect(emojiMs /
 * asciiMs)` is a ratio, not a duration, and must stay matchable against 10.
 */
const MS_BOUND =
	/expect\(\s*(?:[A-Za-z_$][\w$]*\.)*(?:ms|[a-z][\w$]*Ms)[^)/]*\)\s*\.toBeLessThan\(\s*([^)]+?)\s*\)/g;

describe("absolute ms bounds in the render bench (#641)", () => {
	const source = readFileSync(resolve(process.cwd(), BENCH), "utf8");

	it("states every absolute duration bound at catastrophe scale", () => {
		const offenders: string[] = [];
		let found = 0;
		for (const match of source.matchAll(MS_BOUND)) {
			found += 1;
			const bound = match[1] ?? "";
			// A named constant is how the file is meant to express these, and the
			// constant's own value is asserted separately below.
			if (/^[A-Z][A-Z0-9_]*$/.test(bound)) continue;
			const literal = Number(bound);
			if (Number.isFinite(literal) && literal >= MIN_ABSOLUTE_MS_BOUND)
				continue;
			offenders.push(match[0]);
		}

		// The count is asserted before the verdict, because "no offenders" and
		// "the pattern matched nothing" are the same result and only one of them
		// is good news. A rename of `ms` to `elapsed` would silently switch this
		// whole guard off — the exact shape of failure it exists to prevent.
		expect(
			found,
			`no ms bounds matched in ${BENCH} — the pattern has gone stale, not the file clean`,
		).toBeGreaterThan(0);

		expect(
			offenders,
			`absolute ms bounds below ${MIN_ABSOLUTE_MS_BOUND}ms flake on CI — use the ratio ladder for sensitivity, or CATASTROPHE_MS`,
		).toEqual([]);
	});

	it("pins the catastrophe constant itself above the floor", () => {
		// The check above lets a named SCREAMING_CASE constant through without
		// resolving it, so the constant is where a tight bound could re-enter.
		const declared = source.match(/const CATASTROPHE_MS = (\d+);/);
		expect(
			declared,
			"CATASTROPHE_MS is no longer declared in the bench",
		).not.toBeNull();
		expect(Number(declared?.[1])).toBeGreaterThanOrEqual(MIN_ABSOLUTE_MS_BOUND);
	});

	it("keeps the ratio ladder, which is where sensitivity actually lives", () => {
		// The repair for a flaky absolute is to delete it and lean on the ratios.
		// If someone deletes the ratios instead, every remaining bound is a
		// catastrophe net and a 2x regression becomes invisible — a green file
		// that checks almost nothing. Pin the mechanism, not just its absence.
		expect(source).toContain("msPerRow");
		expect(
			source.match(/msPerRow\s*\/\s*\w+\.msPerRow/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(2);
		expect(source).toContain("emojiMs / asciiMs");
	});
});
