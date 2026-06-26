import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "./datetime";

describe("zonedWallTimeToUtc", () => {
	it("converts a summer (CDT, UTC-5) wall time to the correct UTC instant", () => {
		// 7:00 PM CDT = midnight UTC next day
		const result = zonedWallTimeToUtc("2026-07-03T19:00", "America/Chicago");
		expect(result.toISOString()).toBe("2026-07-04T00:00:00.000Z");
	});

	it("converts a winter (CST, UTC-6) wall time — proves DST is handled, not a fixed offset", () => {
		// 7:00 PM CST = 1:00 AM UTC next day
		const result = zonedWallTimeToUtc("2026-01-10T19:00", "America/Chicago");
		expect(result.toISOString()).toBe("2026-01-11T01:00:00.000Z");
	});

	it("is an identity in UTC", () => {
		const result = zonedWallTimeToUtc("2026-07-03T19:00", "UTC");
		expect(result.toISOString()).toBe("2026-07-03T19:00:00.000Z");
	});

	it("throws on a malformed string", () => {
		expect(() => zonedWallTimeToUtc("not-a-date", "America/Chicago")).toThrow(
			"Invalid date/time.",
		);
	});
});
