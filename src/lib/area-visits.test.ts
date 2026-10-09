import { describe, expect, it } from "vitest";
import {
	areaClubPrintPath,
	formatVisitDate,
	isIsoDate,
	outsideProgramYearMessage,
	programYearIsoWindow,
} from "./area-visits";

describe("the visit date rules (#1120)", () => {
	it("takes real calendar days only", () => {
		expect(isIsoDate("2026-10-12")).toBe(true);
		expect(isIsoDate("2028-02-29")).toBe(true);
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
			expect(isIsoDate(bad)).toBe(false);
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

	it("prints a date-only value without a Date, so no zone can move it", () => {
		expect(formatVisitDate("2026-10-12")).toBe("Oct 12");
		expect(formatVisitDate("2026-07-01")).toBe("Jul 1");
		expect(formatVisitDate("2027-12-31")).toBe("Dec 31");
	});

	it("links the summary at the print route", () => {
		expect(areaClubPrintPath("a1", "c2")).toBe("/area/a1/club/c2/print");
	});
});
