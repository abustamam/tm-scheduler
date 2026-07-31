import { describe, expect, it } from "vitest";
import {
	BUCKET_BOUNDARIES,
	CONTENT_W,
	hasWordOfTheDay,
	posterBodySize,
	posterWordSize,
	SAFETY_MARGIN,
	TARGET_W,
} from "./word-poster";

describe("posterWordSize", () => {
	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("apt")).toBe(173); // 3
		expect(posterWordSize("candid")).toBe(173); // 6
		expect(posterWordSize("aplomb!")).toBe(116); // 7
		expect(posterWordSize("ephemeral!")).toBe(116); // 10
		expect(posterWordSize("ephemerally")).toBe(90); // 11
		expect(posterWordSize("magnanimously!")).toBe(90); // 14
		expect(posterWordSize("circumlocution!")).toBe(74); // 15
		expect(posterWordSize("a".repeat(18))).toBe(74); // 18
		expect(posterWordSize("a".repeat(19))).toBe(61); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(61);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(173);
	});

	it("sizes an empty word like a short one — there is no empty-string special case", () => {
		expect(posterWordSize("")).toBe(173);
	});

	// Capitals are far wider than lowercase, so an all-caps word gets its own,
	// much smaller table. Pin the branch from both sides at the same length.
	it("uses the smaller all-caps sizes for a word typed in capitals", () => {
		expect(posterWordSize("EPHEMERAL")).toBe(94); // 9, all caps
		expect(posterWordSize("Ephemeral")).toBe(116); // 9, not all caps
	});

	it("steps down at each all-caps bucket boundary", () => {
		expect(posterWordSize("CANDID")).toBe(141); // 6
		expect(posterWordSize("APLOMB!")).toBe(94); // 7
		expect(posterWordSize("EPHEMERAL!")).toBe(94); // 10
		expect(posterWordSize("EPHEMERALLY")).toBe(65); // 11
		expect(posterWordSize("MAGNANIMOUSLY!")).toBe(65); // 14
		expect(posterWordSize("CIRCUMLOCUTION!")).toBe(52); // 15
		expect(posterWordSize("A".repeat(18))).toBe(52); // 18
		expect(posterWordSize("A".repeat(19))).toBe(44); // 19
	});

	it("treats mixed case as ordinary, not all-caps", () => {
		expect(posterWordSize("EPhemeral")).toBe(116); // 9
	});

	// The all-caps test is "contains a letter AND equals its own uppercase".
	// Digits equal their own uppercase, so without the letter half of that
	// condition "1234" would be sized as shouted text.
	it("sizes letterless input from the normal table", () => {
		expect(posterWordSize("1234")).toBe(173); // 4, no letters
	});

	// The measurement harness sweeps length ranges built from BUCKET_BOUNDARIES
	// and applies the all-caps sizes within them. If the two tables stepped at
	// different lengths, the harness would measure an all-caps bucket over the
	// wrong range and still report PASS.
	it("steps both tables at the same lengths", () => {
		for (const boundary of BUCKET_BOUNDARIES) {
			const at = posterWordSize("A".repeat(boundary));
			const past = posterWordSize("A".repeat(boundary + 1));
			expect(at).not.toBe(past);
		}
		// And the boundaries really are the normal table's, not a stale copy.
		expect([...BUCKET_BOUNDARIES]).toEqual([6, 10, 14, 18]);
	});
});

describe("posterBodySize", () => {
	// A third of the word size at every bucket in BOTH tables, so the definition
	// keeps a constant relationship to the word instead of a fixed size the word
	// drifts away from. Spelled out per bucket because the clamp makes the
	// mapping non-obvious at the ends.
	it("is a third of the word size at each normal bucket", () => {
		expect(posterBodySize("apt")).toBe(32); // 173/3 = 58 → clamped
		expect(posterBodySize("ephemeral!")).toBe(32); // 116/3 = 39 → clamped
		expect(posterBodySize("ephemerally")).toBe(30); // 90/3
		expect(posterBodySize("circumlocution!")).toBe(25); // 74/3 = 24.7
		expect(posterBodySize("a".repeat(19))).toBe(20); // 61/3 = 20.3
	});

	it("is a third of the word size at each all-caps bucket", () => {
		expect(posterBodySize("CANDID")).toBe(32); // 141/3 = 47 → clamped
		expect(posterBodySize("EPHEMERAL!")).toBe(31); // 94/3 = 31.3
		expect(posterBodySize("EPHEMERALLY")).toBe(22); // 65/3 = 21.7
		expect(posterBodySize("A".repeat(18))).toBe(20); // 52/3 = 17.3 → clamped
		expect(posterBodySize("A".repeat(19))).toBe(20); // 44/3 = 14.7 → clamped
	});

	// Both ends of the clamp, from the sizes that actually reach them.
	it("floors at 20px so the body stays legible from the back of the room", () => {
		// 52/3 and 44/3 are both under 20 and both land on the floor.
		expect(Math.round(posterWordSize("A".repeat(18)) / 3)).toBeLessThan(20);
		expect(posterBodySize("A".repeat(18))).toBe(20);
		expect(posterBodySize("A".repeat(40))).toBe(20);
	});

	it("ceilings at 32px so a short word's definition cannot balloon", () => {
		// 173/3 is 58 — nearly double the cap, and would compete with the word.
		expect(Math.round(posterWordSize("apt") / 3)).toBeGreaterThan(32);
		expect(posterBodySize("apt")).toBe(32);
	});

	// The ceiling is also what the poster's `min(23em, CONTENT_W px)` cap is
	// priced against: 23em only stays inside the content box up to ~30px.
	it("keeps the ceiling at a size where 23em still needs the width cap", () => {
		expect(23 * 32).toBeGreaterThan(CONTENT_W);
	});

	it("measures the trimmed word, like the word size it is derived from", () => {
		expect(posterBodySize("   apt   ")).toBe(posterBodySize("apt"));
	});
});

describe("the width budget", () => {
	// TARGET_W is DERIVED, so a change to the page geometry cannot silently
	// re-price the safety margin the sizes were measured with.
	it("keeps the safety margin between the content box and the target", () => {
		expect(TARGET_W).toBe(CONTENT_W - SAFETY_MARGIN);
		expect(SAFETY_MARGIN).toBeGreaterThan(0);
		expect(TARGET_W).toBeLessThan(CONTENT_W);
	});
});

describe("hasWordOfTheDay", () => {
	it("is true for a real word", () => {
		expect(hasWordOfTheDay("Ephemeral")).toBe(true);
	});

	it("is false for null and undefined", () => {
		expect(hasWordOfTheDay(null)).toBe(false);
		expect(hasWordOfTheDay(undefined)).toBe(false);
	});

	it("is false for empty and whitespace-only", () => {
		expect(hasWordOfTheDay("")).toBe(false);
		expect(hasWordOfTheDay("   ")).toBe(false);
		expect(hasWordOfTheDay("\t\n")).toBe(false);
	});

	// The poster route feeds `meeting.wordOfTheDay` (string | null) straight into
	// a `word: string` prop after this check, so the predicate has to do the
	// narrowing — otherwise the call site needs an `as string` cast, which would
	// silently outlive any later weakening of this function. This test fails at
	// TYPECHECK (not at runtime) if the return type stops being `word is string`.
	it("narrows its argument to a string, so callers need no cast", () => {
		const maybe = "Ephemeral" as string | null;
		if (!hasWordOfTheDay(maybe)) throw new Error("expected a word");
		expect(maybe.trim()).toBe("Ephemeral");
	});
});
