// `cap` is the single truncation used by both PDF renderers and by the
// speaker-detail write caps, so a defect here is a defect on the PUBLIC
// unauthenticated role-sheets GET.
import { describe, expect, it } from "vitest";
import { cap } from "./cap";

const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("cap", () => {
	it("returns a short value untouched", () => {
		expect(cap("Ice Breaker", 200)).toBe("Ice Breaker");
	});

	it("truncates with an ellipsis and lands exactly on the cap", () => {
		expect(cap("a".repeat(1_000), 200)).toHaveLength(200);
		expect(cap("a".repeat(1_000), 200).endsWith("…")).toBe(true);
	});

	/**
	 * The bug #522's review found, and the reason this file exists.
	 *
	 * `points` describes only a `max * 2`-unit PREFIX, so `points.length <= max`
	 * alone does NOT mean the whole value fits: for an all-astral string the
	 * prefix holds exactly `max` code points however long the value is, and the
	 * old code returned `value` there — the entire input, straight into
	 * `@react-pdf/renderer`, synchronously, on a public unauthenticated GET.
	 *
	 * Measured before the fix: `cap("😀".repeat(100_000), 200)` returned all
	 * 200,000 UTF-16 units, and a 20,000-emoji club name cost 7,848ms of blocked
	 * event loop against 156ms for the same length in ASCII — a 50x
	 * amplification on the single Node process (ADR-0007).
	 *
	 * This survived #519's adversarial pass because every existing fixture put
	 * an ASCII prefix in front of the emoji, which forces `points.length > max`
	 * and so only ever exercised the truncating branch. That is the one-axis
	 * fixture trap in CLAUDE.md, in its purest form.
	 */
	it("bounds an ALL-astral value instead of returning it whole", () => {
		const out = cap("😀".repeat(100_000), 200);
		expect([...out].length).toBeLessThanOrEqual(200);
		// Absolute ceiling, not one stated relative to the cap: a code point is at
		// most two UTF-16 units, so the output can never exceed 2 * 200.
		expect(out.length).toBeLessThanOrEqual(400);
	});

	it("bounds a value that is exactly at the prefix boundary", () => {
		// `value.length === max * 2` is the edge the added clause turns on.
		for (const n of [199, 200, 201, 399, 400, 401]) {
			const out = cap("😀".repeat(n), 200);
			expect([...out].length).toBeLessThanOrEqual(200);
		}
	});

	it("never emits a lone surrogate", () => {
		for (const input of [
			`a${"🎤".repeat(300)}`,
			"🎤".repeat(300),
			`${"🎤".repeat(150)}a`,
		]) {
			expect(LONE_SURROGATE.test(cap(input, 200))).toBe(false);
		}
	});

	it("costs time proportional to the CAP, not to the input", () => {
		// The regression #519 shipped and fixed: spreading the whole string before
		// deciding to truncate. 8MB must stay in single-digit milliseconds.
		const huge = "x".repeat(8_000_000);
		const astral = "😀".repeat(4_000_000);
		for (const input of [huge, astral]) {
			const t = performance.now();
			cap(input, 200);
			expect(performance.now() - t).toBeLessThan(150);
		}
	});
});
