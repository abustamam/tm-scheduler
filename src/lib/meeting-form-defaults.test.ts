import { describe, expect, it } from "vitest";
import { meetingFormDefaults } from "./meeting-form-defaults";
import type { StoredRecurrenceRule } from "./recurrence-rule";

const TODAY = "2026-10-02"; // a Friday

const monthly: StoredRecurrenceRule = {
	mode: "monthly",
	weekday: 4,
	intervalWeeks: null,
	anchorDate: null,
	ordinals: ["2", "4"],
	timeOfDay: "18:45",
	keepAhead: 4,
	location: "Library",
};

const base = {
	rule: null,
	latestMeetingWall: null,
	clubDefaultLocation: null,
	today: TODAY,
};

describe("meetingFormDefaults", () => {
	it("monthly rule: rule fields, next occurrence after the latest meeting (AC5)", () => {
		expect(
			meetingFormDefaults({
				...base,
				rule: monthly,
				latestMeetingWall: "2026-12-10T18:45",
				clubDefaultLocation: "Room 4",
			}),
		).toEqual({
			mode: "monthly",
			weekday: 4,
			intervalWeeks: 1,
			ordinals: [2, 4],
			timeOfDay: "18:45",
			startDate: "2026-12-24",
			location: "Library",
		});
	});

	it("interval rule keeps its own phase (AC6)", () => {
		const rule: StoredRecurrenceRule = {
			...monthly,
			mode: "interval",
			weekday: 2,
			intervalWeeks: 2,
			anchorDate: "2026-01-06",
			ordinals: null,
		};
		const d = meetingFormDefaults({
			...base,
			rule,
			latestMeetingWall: "2026-12-22T19:00",
		});
		expect(d.startDate).toBe("2027-01-05");
		expect(d.mode).toBe("interval");
		expect(d.intervalWeeks).toBe(2);
		expect(d.ordinals).toEqual([2, 4]);
	});

	it("no rule: latest meeting's weekday and time, club default location (AC7)", () => {
		expect(
			meetingFormDefaults({
				...base,
				latestMeetingWall: "2026-11-04T18:30",
				clubDefaultLocation: "Room 4",
			}),
		).toEqual({
			mode: "interval",
			weekday: 3,
			intervalWeeks: 1,
			ordinals: [2, 4],
			timeOfDay: "18:30",
			startDate: "2026-11-11",
			location: "Room 4",
		});
	});

	it("no rule, no meetings: fallbacks, start today (AC8)", () => {
		expect(meetingFormDefaults(base)).toEqual({
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			ordinals: [2, 4],
			timeOfDay: "19:00",
			startDate: TODAY,
			location: "",
		});
	});

	it("no rule, latest meeting in the past: first matching weekday on/after today (AC9)", () => {
		expect(
			meetingFormDefaults({ ...base, latestMeetingWall: "2026-09-02T18:00" })
				.startDate,
		).toBe("2026-10-07");
	});

	it("rule, latest meeting in the past: rule's first occurrence on/after today (AC9)", () => {
		expect(
			meetingFormDefaults({
				...base,
				rule: monthly,
				latestMeetingWall: "2026-09-02T18:00",
			}).startDate,
		).toBe("2026-10-08");
	});

	it("a rule with no location falls back to the club default (AC10)", () => {
		expect(
			meetingFormDefaults({
				...base,
				rule: { ...monthly, location: null },
				clubDefaultLocation: "Room 4",
			}).location,
		).toBe("Room 4");
	});

	it("never takes the location from the latest meeting", () => {
		// the input has no such field; no default means blank
		expect(
			meetingFormDefaults({ ...base, latestMeetingWall: "2026-11-04T18:30" })
				.location,
		).toBe("");
	});

	it("monthly rule with ordinal last", () => {
		const d = meetingFormDefaults({
			...base,
			rule: { ...monthly, ordinals: ["last"] },
			latestMeetingWall: "2026-10-29T18:45",
		});
		expect(d.ordinals).toEqual(["last"]);
		expect(d.startDate).toBe("2026-11-26");
	});

	it("latest meeting today starts tomorrow's search", () => {
		expect(
			meetingFormDefaults({ ...base, latestMeetingWall: "2026-10-02T18:00" })
				.startDate,
		).toBe("2026-10-09");
	});

	it("a malformed rule falls back for the start date but still supplies the rest", () => {
		const d = meetingFormDefaults({
			...base,
			rule: { ...monthly, ordinals: [] },
			latestMeetingWall: "2026-11-04T18:30",
		});
		expect(d.startDate).toBe("2026-11-05");
		expect(d.timeOfDay).toBe("18:45");
		expect(d.location).toBe("Library");
	});
});
