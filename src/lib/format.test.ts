import { describe, expect, it } from "vitest";
import { formatShortDate } from "./format";

describe("formatShortDate", () => {
	it("formats a date as compact month + day in the given timezone", () => {
		expect(formatShortDate("2026-08-13T19:00:00Z", "UTC")).toBe("Aug 13");
	});

	it("respects the timezone when it shifts the calendar day", () => {
		// 03:00 UTC on Aug 14 is still Aug 13 in Los Angeles.
		expect(formatShortDate("2026-08-14T03:00:00Z", "America/Los_Angeles")).toBe(
			"Aug 13",
		);
	});

	it("accepts a Date instance", () => {
		expect(formatShortDate(new Date("2026-01-05T12:00:00Z"), "UTC")).toBe(
			"Jan 5",
		);
	});
});
