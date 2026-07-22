import { describe, expect, it } from "vitest";
import {
	localDateKey,
	localDayRange,
	meetingUrlKey,
	nextCalendarDate,
	parseMeetingKey,
	urlKeysForMeetings,
} from "./meeting-url";

const CHICAGO = "America/Chicago";

describe("parseMeetingKey", () => {
	it("parses a bare date", () => {
		expect(parseMeetingKey("2026-07-21")).toEqual({
			kind: "date",
			date: "2026-07-21",
		});
	});
	it("parses a date + HHmm instant", () => {
		expect(parseMeetingKey("2026-07-21-1845")).toEqual({
			kind: "instant",
			date: "2026-07-21",
			hh: "18",
			mm: "45",
		});
	});
	it("parses a uuid", () => {
		const id = "9f3c1a2b-0000-4000-8000-000000000000";
		expect(parseMeetingKey(id)).toEqual({ kind: "uuid", id });
	});
	it("rejects anything else", () => {
		expect(parseMeetingKey("guest-book").kind).toBe("invalid");
		expect(parseMeetingKey("").kind).toBe("invalid");
		// "2026-13-99" matches the date-shape regex → parsed as a (shape-only) date.
		expect(parseMeetingKey("2026-13-99")).toEqual({
			kind: "date",
			date: "2026-13-99",
		});
	});
});

describe("localDateKey", () => {
	it("uses the club-local calendar date, not the UTC date", () => {
		// 02:30Z on the 22nd is 21:30 on the 21st in Chicago (UTC-5 in July).
		expect(localDateKey(new Date("2026-07-22T02:30:00Z"), CHICAGO)).toBe(
			"2026-07-21",
		);
	});
});

describe("meetingUrlKey", () => {
	// 23:45Z → 18:45 local on 2026-07-21 in Chicago.
	const at = new Date("2026-07-21T23:45:00Z");
	it("is the bare local date when it does not collide", () => {
		expect(meetingUrlKey(at, CHICAGO, false)).toBe("2026-07-21");
	});
	it("appends -HHmm local time when it collides", () => {
		expect(meetingUrlKey(at, CHICAGO, true)).toBe("2026-07-21-1845");
	});
});

describe("nextCalendarDate", () => {
	it("increments a day", () => {
		expect(nextCalendarDate("2026-07-21")).toBe("2026-07-22");
	});
	it("rolls over month and year", () => {
		expect(nextCalendarDate("2026-12-31")).toBe("2027-01-01");
		expect(nextCalendarDate("2026-02-28")).toBe("2026-03-01"); // 2026 not leap
	});
});

describe("localDayRange", () => {
	it("returns the club-local midnight-to-midnight UTC window", () => {
		const { start, end } = localDayRange("2026-07-21", CHICAGO);
		// Midnight CDT (UTC-5) on 07-21 → 05:00Z; next midnight → 05:00Z on 07-22.
		expect(start.toISOString()).toBe("2026-07-21T05:00:00.000Z");
		expect(end.toISOString()).toBe("2026-07-22T05:00:00.000Z");
	});
});

describe("urlKeysForMeetings", () => {
	it("suffixes only the meetings that share a local date", () => {
		const items = [
			{ id: "a", scheduledAt: new Date("2026-07-21T23:45:00Z") }, // 18:45 local
			{ id: "b", scheduledAt: new Date("2026-07-22T01:00:00Z") }, // 20:00 local, SAME local day
			{ id: "c", scheduledAt: new Date("2026-07-28T23:45:00Z") }, // different day
		];
		const keys = urlKeysForMeetings(items, CHICAGO);
		expect(keys.get("a")).toBe("2026-07-21-1845");
		expect(keys.get("b")).toBe("2026-07-21-2000");
		expect(keys.get("c")).toBe("2026-07-28");
	});
});
