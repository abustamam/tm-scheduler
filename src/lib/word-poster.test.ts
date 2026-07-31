import { describe, expect, it } from "vitest";
import { posterWordSize } from "./word-poster";

describe("posterWordSize", () => {
	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("apt")).toBe(200); // 3
		expect(posterWordSize("candid")).toBe(200); // 6
		expect(posterWordSize("aplomb!")).toBe(150); // 7
		expect(posterWordSize("ephemeral!")).toBe(150); // 10
		expect(posterWordSize("ephemerally")).toBe(112); // 11
		expect(posterWordSize("magnanimously!")).toBe(112); // 14
		expect(posterWordSize("circumlocution!")).toBe(88); // 15
		expect(posterWordSize("a".repeat(18))).toBe(88); // 18
		expect(posterWordSize("a".repeat(19))).toBe(68); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(68);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(200);
	});

	it("sizes an empty word like a short one — there is no empty-string special case", () => {
		expect(posterWordSize("")).toBe(200);
	});
});
