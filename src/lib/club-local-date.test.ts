/**
 * The four club-local date helpers, now that they live somewhere a test can
 * import them without a database (#776 item 5).
 *
 * The move is behaviour-preserving, so the cases here are the ones that pin
 * WHY each is written the way it is: calendar arithmetic rather than instant
 * arithmetic, and a weekday read off the club-local date rather than off the
 * instant. Both were load-bearing in the tool modules and neither was asserted
 * anywhere, because neither could be reached.
 */
import { describe, expect, it } from "vitest";
import {
	addMonthsToLocalDate,
	clubLocalParts,
	localDate,
	nextLocalDate,
} from "./club-local-date";

describe("localDate", () => {
	it("accepts a club-local YYYY-MM-DD and nothing else", () => {
		expect(localDate.safeParse("2026-09-16").success).toBe(true);
		for (const bad of [
			"2026-9-16",
			"16-09-2026",
			"2026-09-16T19:00",
			"2026-09-16Z",
			"today",
			"",
		]) {
			expect(localDate.safeParse(bad).success, bad).toBe(false);
		}
	});

	it("says what to send when it refuses", () => {
		const parsed = localDate.safeParse("tuesday");
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toBe(
			"Use a club-local date, YYYY-MM-DD.",
		);
	});
});

describe("addMonthsToLocalDate", () => {
	it("moves whole months", () => {
		expect(addMonthsToLocalDate("2026-09-16", 3)).toBe("2026-12-16");
		expect(addMonthsToLocalDate("2026-10-31", 3)).toBe("2027-01-31");
		expect(addMonthsToLocalDate("2026-09-16", 0)).toBe("2026-09-16");
	});

	it("clamps a month end the way JavaScript does, and says so", () => {
		// 31 Jan + 1 month has no 31st to land on, so `setUTCMonth` rolls into
		// March. Fine for a search window's upper bound; it is the documented
		// reason this helper is only used there.
		expect(addMonthsToLocalDate("2026-01-31", 1)).toBe("2026-03-03");
		expect(addMonthsToLocalDate("2028-01-31", 1)).toBe("2028-03-02"); // leap
		// Nov 30 + 3 months is Feb 30, which rolls to Mar 2 in a common year.
		expect(addMonthsToLocalDate("2026-11-30", 3)).toBe("2027-03-02");
	});

	it("is calendar arithmetic — no timezone can shift it", () => {
		// Spring forward in America/Chicago is 2026-03-08. Adding months across
		// it moves dates, never hours, so the day-of-month is unchanged.
		expect(addMonthsToLocalDate("2026-02-08", 1)).toBe("2026-03-08");
		expect(addMonthsToLocalDate("2026-03-08", 1)).toBe("2026-04-08");
	});
});

describe("nextLocalDate", () => {
	it("rolls the day, the month and the year", () => {
		expect(nextLocalDate("2026-09-16")).toBe("2026-09-17");
		expect(nextLocalDate("2026-09-30")).toBe("2026-10-01");
		expect(nextLocalDate("2026-12-31")).toBe("2027-01-01");
	});

	it("knows February", () => {
		expect(nextLocalDate("2026-02-28")).toBe("2026-03-01");
		expect(nextLocalDate("2028-02-28")).toBe("2028-02-29"); // leap year
		expect(nextLocalDate("2028-02-29")).toBe("2028-03-01");
	});

	it("advances exactly one calendar date across a DST boundary", () => {
		// The club-local day of 2026-03-08 is 23 hours long in America/Chicago and
		// 2026-11-01 is 25. "The next date" is one date later in both cases, which
		// is why the day range is built from two local midnights rather than by
		// adding 24h to the first.
		expect(nextLocalDate("2026-03-08")).toBe("2026-03-09");
		expect(nextLocalDate("2026-11-01")).toBe("2026-11-02");
	});
});

describe("clubLocalParts", () => {
	it("reports the club's own date, time and weekday", () => {
		// 2026-09-17T00:30Z is still Wednesday the 16th, 7:30pm, in Chicago.
		const parts = clubLocalParts(
			new Date("2026-09-17T00:30:00Z"),
			"America/Chicago",
		);
		expect(parts).toEqual({
			date: "2026-09-16",
			time: "19:30",
			weekday: "Wednesday",
		});
	});

	it("reads the weekday off the club-local DATE, not the instant", () => {
		// The same instant is Thursday in UTC and Wednesday in Chicago. A weekday
		// taken from the instant would print the wrong day for half the year,
		// which is the whole reason a token caller gets club-local dates at all.
		const instant = new Date("2026-09-17T00:30:00Z");
		expect(clubLocalParts(instant, "UTC")).toEqual({
			date: "2026-09-17",
			time: "00:30",
			weekday: "Thursday",
		});
		expect(clubLocalParts(instant, "America/Chicago").weekday).toBe(
			"Wednesday",
		);
	});

	it("survives the DST changeover in the club's own zone", () => {
		// 2026-11-01T06:30Z is 01:30 CDT; an hour later is 01:30 CST, the same
		// wall-clock time on the same date.
		expect(
			clubLocalParts(new Date("2026-11-01T06:30:00Z"), "America/Chicago"),
		).toEqual({ date: "2026-11-01", time: "01:30", weekday: "Sunday" });
		expect(
			clubLocalParts(new Date("2026-11-01T07:30:00Z"), "America/Chicago"),
		).toEqual({ date: "2026-11-01", time: "01:30", weekday: "Sunday" });
	});
});
