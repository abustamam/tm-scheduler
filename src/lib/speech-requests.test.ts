import { describe, expect, it } from "vitest";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
import {
	clipImportedText,
	clubDayOf,
	isCalendarDay,
	isPreferredDay,
	MAX_PREFERRED_DATES,
	normalizePreferredDates,
	preferredDatesField,
	sortSpeechQueue,
	speechRequestFieldsSchema,
} from "./speech-requests";

describe("isCalendarDay", () => {
	it("accepts a real day and refuses an impossible or malformed one", () => {
		expect(isCalendarDay("2026-02-28")).toBe(true);
		expect(isCalendarDay("2028-02-29")).toBe(true);
		expect(isCalendarDay("2026-02-31")).toBe(false);
		expect(isCalendarDay("2026-02-29")).toBe(false);
		expect(isCalendarDay("2026-13-01")).toBe(false);
		expect(isCalendarDay("2026-2-3")).toBe(false);
		expect(isCalendarDay("")).toBe(false);
	});
});

describe("preferredDatesField", () => {
	it("keeps up to three distinct real days in the order given", () => {
		expect(
			preferredDatesField.parse(["2026-03-10", "2026-03-03", "2026-03-17"]),
		).toEqual(["2026-03-10", "2026-03-03", "2026-03-17"]);
		expect(MAX_PREFERRED_DATES).toBe(3);
	});

	it("refuses a fourth date, a duplicate and an impossible day", () => {
		expect(
			preferredDatesField.safeParse([
				"2026-03-01",
				"2026-03-02",
				"2026-03-03",
				"2026-03-04",
			]).success,
		).toBe(false);
		expect(
			preferredDatesField.safeParse(["2026-03-01", "2026-03-01"]).success,
		).toBe(false);
		expect(preferredDatesField.safeParse(["2026-02-31"]).success).toBe(false);
	});
});

describe("normalizePreferredDates (the import's trust-nothing path)", () => {
	it("drops blanks, impossible days and repeats, then caps at three", () => {
		expect(
			normalizePreferredDates([
				"2026-03-01",
				null,
				"2026-02-31",
				"",
				"2026-03-01",
				"2026-03-02",
				undefined,
				"2026-03-03",
				"2026-03-04",
			]),
		).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
	});
});

describe("speechRequestFieldsSchema", () => {
	it("stores a blank or whitespace-only field as null and trims the rest", () => {
		expect(
			speechRequestFieldsSchema.parse({
				title: "  My Ice Breaker  ",
				path: "   ",
				projectName: "",
			}),
		).toEqual({
			title: "My Ice Breaker",
			path: null,
			projectName: null,
			introduction: null,
			preferredDates: [],
		});
	});

	it("refuses a title past the speech-title limit", () => {
		expect(
			speechRequestFieldsSchema.safeParse({
				title: "x".repeat(SPEAKER_LIMITS.speechTitle + 1),
			}).success,
		).toBe(false);
	});
});

describe("clipImportedText", () => {
	it("cuts to the field's cap instead of refusing", () => {
		const long = "y".repeat(SPEAKER_LIMITS.speechTitle + 50);
		expect(clipImportedText(long, "title")).toHaveLength(
			SPEAKER_LIMITS.speechTitle,
		);
		expect(
			clipImportedText("z".repeat(SPEAKER_LIMITS.pathwayPath + 5), "path"),
		).toHaveLength(SPEAKER_LIMITS.pathwayPath);
		expect(
			clipImportedText(
				"z".repeat(SPEAKER_LIMITS.projectName + 5),
				"projectName",
			),
		).toHaveLength(SPEAKER_LIMITS.projectName);
		expect(
			clipImportedText(
				"z".repeat(SPEAKER_LIMITS.introduction + 5),
				"introduction",
			),
		).toHaveLength(SPEAKER_LIMITS.introduction);
	});

	it("trims, and turns blank and missing into null", () => {
		expect(clipImportedText("  hello  ", "title")).toBe("hello");
		expect(clipImportedText("   ", "title")).toBeNull();
		expect(clipImportedText("", "path")).toBeNull();
		expect(clipImportedText(null, "introduction")).toBeNull();
		expect(clipImportedText(undefined, "projectName")).toBeNull();
	});
});

describe("sortSpeechQueue", () => {
	const row = (id: string, lastSpokeAt: string | null, createdAt: string) => ({
		id,
		lastSpokeAt,
		createdAt,
	});

	it("puts never-spoken first, then the longest since last spoke", () => {
		const sorted = sortSpeechQueue([
			row("recent", "2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z"),
			row("long-ago", "2025-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
			row("never", null, "2026-01-03T00:00:00Z"),
		]);
		expect(sorted.map((r) => r.id)).toEqual(["never", "long-ago", "recent"]);
	});

	it("breaks a tie on last-spoke by the oldest request", () => {
		const sorted = sortSpeechQueue([
			row("newer", null, "2026-02-01T00:00:00Z"),
			row("older", null, "2026-01-01T00:00:00Z"),
			row("same-day-b", "2025-05-05T00:00:00Z", "2026-03-01T00:00:00Z"),
			row("same-day-a", "2025-05-05T00:00:00Z", "2026-02-15T00:00:00Z"),
		]);
		expect(sorted.map((r) => r.id)).toEqual([
			"older",
			"newer",
			"same-day-a",
			"same-day-b",
		]);
	});

	it("keeps the input order for full ties, accepts Dates, and does not mutate", () => {
		const input = [
			{
				id: "a",
				lastSpokeAt: new Date("2025-01-01T00:00:00Z"),
				createdAt: new Date("2026-01-01T00:00:00Z"),
			},
			{
				id: "b",
				lastSpokeAt: new Date("2025-01-01T00:00:00Z"),
				createdAt: new Date("2026-01-01T00:00:00Z"),
			},
		];
		const sorted = sortSpeechQueue(input);
		expect(sorted.map((r) => r.id)).toEqual(["a", "b"]);
		expect(sorted).not.toBe(input);
		expect(sortSpeechQueue([])).toEqual([]);
	});
});

describe("club-local days", () => {
	it("reads the day in the club's zone, not UTC", () => {
		// 2026-03-11T02:00Z is still the 10th in Los Angeles.
		const instant = "2026-03-11T02:00:00Z";
		expect(clubDayOf(instant, "America/Los_Angeles")).toBe("2026-03-10");
		expect(clubDayOf(instant, "UTC")).toBe("2026-03-11");
		expect(isPreferredDay(instant, "America/Los_Angeles", ["2026-03-10"])).toBe(
			true,
		);
		expect(isPreferredDay(instant, "America/Los_Angeles", ["2026-03-11"])).toBe(
			false,
		);
	});
});
