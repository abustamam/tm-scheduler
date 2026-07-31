import { describe, expect, it } from "vitest";
import { posterWordSize } from "./word-poster";

describe("posterWordSize", () => {
	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("apt")).toBe(177); // 3
		expect(posterWordSize("candid")).toBe(177); // 6
		expect(posterWordSize("aplomb!")).toBe(130); // 7
		expect(posterWordSize("ephemeral!")).toBe(130); // 10
		expect(posterWordSize("ephemerally")).toBe(97); // 11
		expect(posterWordSize("magnanimously!")).toBe(97); // 14
		expect(posterWordSize("circumlocution!")).toBe(81); // 15
		expect(posterWordSize("a".repeat(18))).toBe(81); // 18
		expect(posterWordSize("a".repeat(19))).toBe(68); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(68);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(177);
	});

	it("sizes an empty word like a short one — there is no empty-string special case", () => {
		expect(posterWordSize("")).toBe(177);
	});
});
