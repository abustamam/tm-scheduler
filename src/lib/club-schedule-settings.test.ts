import { describe, expect, it } from "vitest";
import {
	MAX_DEFAULT_MEETING_MINUTES,
	MAX_SCHEDULE_TEXT_CHARS,
	normalizeScheduleText,
} from "./club-schedule-settings";

describe("club schedule settings bounds (#1514)", () => {
	it("pins the absolute caps, not just their relation to the constants", () => {
		expect(MAX_DEFAULT_MEETING_MINUTES).toBe(1440);
		expect(MAX_SCHEDULE_TEXT_CHARS).toBe(200);
		// The boundary a caller's schema enforces: 1440 in, 1441 out; 200 in, 201 out.
		expect(1440 <= MAX_DEFAULT_MEETING_MINUTES).toBe(true);
		expect(1441 <= MAX_DEFAULT_MEETING_MINUTES).toBe(false);
		expect("x".repeat(200).length <= MAX_SCHEDULE_TEXT_CHARS).toBe(true);
		expect("x".repeat(201).length <= MAX_SCHEDULE_TEXT_CHARS).toBe(false);
	});

	it("trims text and turns blank, whitespace-only, null and undefined into null", () => {
		expect(normalizeScheduleText("  Thursdays, 6:45 PM  ")).toBe(
			"Thursdays, 6:45 PM",
		);
		expect(normalizeScheduleText("")).toBeNull();
		expect(normalizeScheduleText("   \t\n")).toBeNull();
		expect(normalizeScheduleText(null)).toBeNull();
		expect(normalizeScheduleText(undefined)).toBeNull();
	});
});
