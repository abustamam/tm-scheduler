import { describe, expect, it } from "vitest";
import {
	formatMeetingTime,
	formatMeetingTimeRange,
	formatShortDate,
} from "./format";

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

describe("formatMeetingTimeRange", () => {
	const start = new Date("2026-08-01T18:30:00Z");

	it("derives the end time from start + length", () => {
		const range = formatMeetingTimeRange(start, 90, "UTC");
		expect(range).toBe(
			`${formatMeetingTime(start, "UTC")} – ${formatMeetingTime(
				new Date("2026-08-01T20:00:00Z"),
				"UTC",
			)}`,
		);
		// 90 minutes after 6:30 PM is 8:00 PM.
		expect(range).toContain("6:30");
		expect(range).toContain("8:00");
	});

	it("falls back to start-only when length is missing/zero", () => {
		expect(formatMeetingTimeRange(start, null, "UTC")).toBe(
			formatMeetingTime(start, "UTC"),
		);
		expect(formatMeetingTimeRange(start, 0, "UTC")).toBe(
			formatMeetingTime(start, "UTC"),
		);
	});

	it("accepts an ISO string input", () => {
		expect(formatMeetingTimeRange(start.toISOString(), 60, "UTC")).toBe(
			formatMeetingTimeRange(start, 60, "UTC"),
		);
	});
});
