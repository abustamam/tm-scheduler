// protects=the loose-date rules and the speech-log merge order of past speeches (#1656)
import { describe, expect, it } from "vitest";
import {
	compareSpeechLogRows,
	type MergeableLogRow,
	pastSpeechSortInstant,
	requirePastSpeechTitle,
	validatePastSpeechDate,
} from "./past-speech";

const now = new Date("2026-11-17T12:00:00Z");
const meeting = (id: string, iso: string): MergeableLogRow => ({
	kind: "meeting",
	slotId: id,
	scheduledAt: new Date(iso),
});
const past = (
	id: string,
	year: number | null,
	month: number | null,
	created = "2026-01-01",
): MergeableLogRow => ({
	kind: "past",
	speechId: id,
	deliveredYear: year,
	deliveredMonth: month,
	createdAt: new Date(created),
});
const order = (rows: MergeableLogRow[]) =>
	[...rows]
		.sort(compareSpeechLogRows)
		.map((r) => (r.kind === "meeting" ? r.slotId : r.speechId));

describe("compareSpeechLogRows", () => {
	// fails_when=a past speech sorts by anything but its loose date; no_claim=SQL order
	it("places a month-dated past speech between the meetings around it", () => {
		expect(
			order([
				meeting("feb", "2023-02-10T00:00:00Z"),
				past("mar", 2023, 3),
				meeting("apr", "2023-04-10T00:00:00Z"),
			]),
		).toEqual(["apr", "mar", "feb"]);
	});
	// fails_when=year-only sorts above Jan 1 meetings
	it("sorts a year-only speech at Jan 1, below later meetings that year", () => {
		expect(
			order([past("y", 2022, null), meeting("m", "2022-01-02T00:00:00Z")]),
		).toEqual(["m", "y"]);
	});
	// fails_when=undated rows interleave with dated ones
	it("puts undated rows after every dated row, newest created first", () => {
		expect(
			order([
				past("u1", null, null, "2026-01-01"),
				past("u2", null, null, "2026-02-01"),
				meeting("old", "1999-01-01T00:00:00Z"),
			]),
		).toEqual(["old", "u2", "u1"]);
	});
	// fails_when=a tie is not broken meeting-first then by created_at, id
	it("breaks ties: meeting first, then newer created_at, then id", () => {
		expect(
			order([
				past("a", 2023, 1, "2026-01-01"),
				past("b", 2023, 1, "2026-03-01"),
				meeting("m", "2023-01-01T00:00:00Z"),
			]),
		).toEqual(["m", "b", "a"]);
		expect(order([past("a", 2023, 1), past("b", 2023, 1)])).toEqual(["b", "a"]);
	});
	it("computes the sort instant in UTC", () => {
		expect(pastSpeechSortInstant(2023, 3)).toBe(Date.UTC(2023, 2, 1));
		expect(pastSpeechSortInstant(2023, null)).toBe(Date.UTC(2023, 0, 1));
		expect(pastSpeechSortInstant(null, null)).toBeNull();
	});
});

describe("validatePastSpeechDate / requirePastSpeechTitle", () => {
	const v = (year: number | null, month: number | null, timezone = "UTC") =>
		validatePastSpeechDate({ year, month, now, timezone });
	// fails_when=a month is accepted without a year
	it("refuses a month without a year", () => {
		expect(() => v(null, 3)).toThrow("year before a month");
	});
	// fails_when=a future year is accepted
	it("refuses a year above the current one, in the club's timezone", () => {
		expect(() => v(2027, null)).toThrow("future");
		expect(v(2026, 11)).toEqual({ year: 2026, month: 11 });
		// 2026-12-31 23:00 UTC is already 2027 in Auckland.
		const nye = new Date("2026-12-31T23:00:00Z");
		expect(
			validatePastSpeechDate({
				year: 2027,
				month: null,
				now: nye,
				timezone: "Pacific/Auckland",
			}).year,
		).toBe(2027);
		expect(() =>
			validatePastSpeechDate({
				year: 2027,
				month: null,
				now: nye,
				timezone: "UTC",
			}),
		).toThrow("future");
	});
	// protects=a month after this month is not a past date (#1656)
	// fails_when=the month check is dropped, or runs in UTC not the club's zone
	it("refuses a month after the current month in the current year only", () => {
		const mid = new Date("2026-06-15T12:00:00Z");
		const at = (year: number, month: number, timezone: string | null) =>
			validatePastSpeechDate({ year, month, now: mid, timezone });
		expect(at(2026, 6, "UTC")).toEqual({ year: 2026, month: 6 });
		expect(() => at(2026, 7, "UTC")).toThrow("future");
		// An earlier year is not bound by this year's month.
		expect(at(2025, 12, "UTC")).toEqual({ year: 2025, month: 12 });
		// 2026-06-30 23:00 UTC is already July 1 in Auckland, and still June in UTC.
		const eom = new Date("2026-06-30T23:00:00Z");
		expect(
			validatePastSpeechDate({
				year: 2026,
				month: 7,
				now: eom,
				timezone: "Pacific/Auckland",
			}).month,
		).toBe(7);
		expect(() =>
			validatePastSpeechDate({
				year: 2026,
				month: 7,
				now: eom,
				timezone: null,
			}),
		).toThrow("future");
	});
	it("accepts no date at all and refuses a year before 1900", () => {
		expect(v(null, null)).toEqual({ year: null, month: null });
		expect(() => v(1899, null)).toThrow("1900");
		expect(() => v(2020, 13)).toThrow("1 to 12");
	});
	// fails_when=a blank or TBA title is accepted
	it("requires a real title", () => {
		expect(() => requirePastSpeechTitle("  ")).toThrow("needs a title");
		expect(() => requirePastSpeechTitle("TBA")).toThrow("needs a title");
		expect(() => requirePastSpeechTitle("Ice Breaker")).not.toThrow();
	});
});
