import { describe, expect, it } from "vitest";
import { posterWordSize } from "./word-poster";

describe("posterWordSize", () => {
	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("apt")).toBe(190); // 3
		expect(posterWordSize("candid")).toBe(190); // 6
		expect(posterWordSize("aplomb!")).toBe(145); // 7
		expect(posterWordSize("ephemeral!")).toBe(145); // 10
		expect(posterWordSize("ephemerally")).toBe(100); // 11
		expect(posterWordSize("magnanimously!")).toBe(100); // 14
		expect(posterWordSize("circumlocution!")).toBe(80); // 15
		expect(posterWordSize("a".repeat(18))).toBe(80); // 18
		expect(posterWordSize("a".repeat(19))).toBe(64); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(64);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(190);
	});

	it("sizes an empty word like a short one — there is no empty-string special case", () => {
		expect(posterWordSize("")).toBe(190);
	});
});
