import { describe, expect, it, vi } from "vitest";
import {
	formatCalendarDay,
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

describe("formatCalendarDay (#529)", () => {
	// The regression test for a bug that shipped past five reviewers: an action
	// item's due date is a CALENDAR DAY, and putting one through
	// `new Date("2026-08-10")` yields UTC midnight, which formats as the 9th
	// anywhere west of UTC. This repo's default club timezone is America/Chicago,
	// so that was very nearly every user — and the SSR container (UTC) disagreed
	// with the hydrated client, so the string changed under the reader.
	//
	// The zone is injected rather than taken from `process.env.TZ`, which Node
	// only reads at startup: a TZ assigned inside the test would be ignored, the
	// suite would run in CI's UTC where the bug does not manifest at all, and the
	// test could never fail. Stubbing the DEFAULT zone instead makes it
	// deterministic everywhere — the correct implementation pins `timeZone: "UTC"`
	// explicitly and is unaffected, the buggy one inherits the stub and shifts.
	const RealDateTimeFormat = Intl.DateTimeFormat;

	function withDefaultZone(timeZone: string, run: () => void) {
		// Must be constructible — `formatCalendarDay` calls `new Intl.DateTimeFormat`.
		function Stub(locale?: string, options?: Intl.DateTimeFormatOptions) {
			return new RealDateTimeFormat(locale ?? "en-US", {
				...options,
				timeZone: options?.timeZone ?? timeZone,
			});
		}
		const stub = Stub as unknown as typeof Intl.DateTimeFormat;
		vi.spyOn(Intl, "DateTimeFormat").mockImplementation(stub);
		try {
			run();
		} finally {
			vi.mocked(Intl.DateTimeFormat).mockRestore();
		}
	}

	it("shows the day that was picked, whatever zone the viewer is in", () => {
		// Both sides of UTC. An implementation that inherits the ambient zone
		// cannot pass the west-of-UTC cases.
		for (const tz of [
			"America/Chicago",
			"America/Los_Angeles",
			"UTC",
			"Asia/Tokyo",
		]) {
			withDefaultZone(tz, () => {
				expect(formatCalendarDay("2026-08-10")).toBe("Aug 10");
			});
		}
	});

	it("does not shift a day across a month boundary", () => {
		withDefaultZone("America/Chicago", () => {
			expect(formatCalendarDay("2026-09-01")).toBe("Sep 1");
			expect(formatCalendarDay("2026-01-01")).toBe("Jan 1");
			// `withYear` (#531): a training window spans two calendar years
			// ("Nov 1, 2026 – Feb 28, 2027") and is meaningless without it. Same
			// UTC pinning, which is the reason it is an option here rather than a
			// second function somebody would write without it.
			expect(formatCalendarDay("2026-08-10", { withYear: true })).toBe(
				"Aug 10, 2026",
			);
			expect(formatCalendarDay("2027-02-28", { withYear: true })).toBe(
				"Feb 28, 2027",
			);
			// Explicit false and an absent option behave identically.
			expect(formatCalendarDay("2026-08-10", { withYear: false })).toBe(
				"Aug 10",
			);
		});
	});

	it("hands back anything that is not a plain calendar day", () => {
		// Better a visibly wrong value than a confident "Invalid Date".
		expect(formatCalendarDay("")).toBe("");
		expect(formatCalendarDay("2026-08-10T00:00:00Z")).toBe(
			"2026-08-10T00:00:00Z",
		);
	});
});
