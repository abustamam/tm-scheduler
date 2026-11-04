import { describe, expect, it } from "vitest";
import { monthLabel } from "./month-label";

describe("monthLabel", () => {
	it("names a valid month from a fixed English list", () => {
		expect(monthLabel("2026-05")).toBe("May 2026");
		expect(monthLabel("2004-12")).toBe("December 2004");
	});

	it("returns an invalid month unchanged", () => {
		expect(monthLabel("2026-13")).toBe("2026-13");
		expect(monthLabel("")).toBe("");
	});
});
