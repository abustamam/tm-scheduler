import { describe, expect, it } from "vitest";
import {
	areaClubPrintPath,
	isCalendarDate,
	isVisitRound,
	outsideProgramYearMessage,
	programYearIsoWindow,
	VISIT_ROUNDS,
} from "./area-visits";

describe("the visit date rules (#1120)", () => {
	it("takes real calendar days only", () => {
		expect(isCalendarDate("2026-10-12")).toBe(true);
		expect(isCalendarDate("2028-02-29")).toBe(true);
		for (const bad of [
			"2026-02-31",
			"2027-02-29",
			"2026-13-01",
			"26-10-12",
			"2026-10-12T00:00:00Z",
			"",
			null,
			20261012,
		]) {
			expect(isCalendarDate(bad)).toBe(false);
		}
	});

	it("states the program year as ISO strings, not as Dates in the server's zone", () => {
		expect(programYearIsoWindow(2026)).toEqual({
			start: "2026-07-01",
			end: "2027-07-01",
		});
		// String order is date order: June 30 is before the window, July 1 in it.
		const { start } = programYearIsoWindow(2026);
		expect("2026-06-30" < start).toBe(true);
		expect("2026-07-01" < start).toBe(false);
		expect(outsideProgramYearMessage(2026)).toContain("2026–27");
	});

	it("knows the rounds from VISIT_ROUNDS alone", () => {
		for (const round of VISIT_ROUNDS) expect(isVisitRound(round)).toBe(true);
		for (const bad of [0, 3, "1", null, undefined, 1.5]) {
			expect(isVisitRound(bad)).toBe(false);
		}
	});

	it("links the summary at the print route", () => {
		expect(areaClubPrintPath("a1", "c2")).toBe("/area/a1/club/c2/print");
	});
});
