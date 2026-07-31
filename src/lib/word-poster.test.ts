import { describe, expect, it } from "vitest";
import { posterWordSize } from "./word-poster";

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
});
