import { describe, expect, it } from "vitest";
import {
	MAX_DEFAULT_MEETING_MINUTES,
	MAX_SCHEDULE_TEXT_CHARS,
	normalizeScheduleText,
} from "./club-schedule-settings";

describe("club schedule settings bounds (#1514)", () => {
	it("pins the absolute caps (the boundary itself is tested through the tool's schema)", () => {
		expect(MAX_DEFAULT_MEETING_MINUTES).toBe(1440);
		expect(MAX_SCHEDULE_TEXT_CHARS).toBe(200);
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
