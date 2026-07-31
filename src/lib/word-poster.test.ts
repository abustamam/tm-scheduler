import { describe, expect, it } from "vitest";
import { posterWordSize } from "./word-poster";

describe("posterWordSize", () => {
	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("apt")).toBe(177); // 3
		expect(posterWordSize("candid")).toBe(177); // 6
		expect(posterWordSize("aplomb!")).toBe(119); // 7
		expect(posterWordSize("ephemeral!")).toBe(119); // 10
		expect(posterWordSize("ephemerally")).toBe(93); // 11
		expect(posterWordSize("magnanimously!")).toBe(93); // 14
		expect(posterWordSize("circumlocution!")).toBe(79); // 15
		expect(posterWordSize("a".repeat(18))).toBe(79); // 18
		expect(posterWordSize("a".repeat(19))).toBe(63); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(63);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(177);
	});

	it("sizes an empty word like a short one — there is no empty-string special case", () => {
		expect(posterWordSize("")).toBe(177);
	});

	// Capitals are far wider than lowercase, so an all-caps word gets its own,
	// much smaller table. Pin the branch from both sides at the same length.
	it("uses the smaller all-caps sizes for a word typed in capitals", () => {
		expect(posterWordSize("EPHEMERAL")).toBe(97); // 9, all caps
		expect(posterWordSize("Ephemeral")).toBe(119); // 9, not all caps
	});

	it("steps down at each all-caps bucket boundary", () => {
		expect(posterWordSize("CANDID")).toBe(145); // 6
		expect(posterWordSize("APLOMB!")).toBe(97); // 7
		expect(posterWordSize("EPHEMERAL!")).toBe(97); // 10
		expect(posterWordSize("EPHEMERALLY")).toBe(67); // 11
		expect(posterWordSize("MAGNANIMOUSLY!")).toBe(67); // 14
		expect(posterWordSize("CIRCUMLOCUTION!")).toBe(54); // 15
		expect(posterWordSize("A".repeat(18))).toBe(54); // 18
		expect(posterWordSize("A".repeat(19))).toBe(45); // 19
	});

	it("treats mixed case as ordinary, not all-caps", () => {
		expect(posterWordSize("EPhemeral")).toBe(119); // 9
	});

	// The all-caps test is "contains a letter AND equals its own uppercase".
	// Digits equal their own uppercase, so without the letter half of that
	// condition "1234" would be sized as shouted text.
	it("sizes letterless input from the normal table", () => {
		expect(posterWordSize("1234")).toBe(177); // 4, no letters
	});
});
