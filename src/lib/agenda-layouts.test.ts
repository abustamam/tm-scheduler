import { describe, expect, it } from "vitest";
import {
	AGENDA_LAYOUT_HINTS,
	AGENDA_LAYOUT_LABELS,
	AGENDA_LAYOUTS,
	isAgendaLayout,
} from "./agenda-layouts";

describe("isAgendaLayout (#1069)", () => {
	it("accepts each of the four layouts", () => {
		for (const id of AGENDA_LAYOUTS) expect(isAgendaLayout(id)).toBe(true);
	});

	it("refuses anything else, including what a hand-typed URL carries", () => {
		for (const bad of [
			undefined,
			null,
			"",
			"Grid",
			"bogus",
			" grid",
			1,
			["grid"],
			{ layout: "grid" },
		]) {
			expect(isAgendaLayout(bad)).toBe(false);
		}
	});

	it("names and describes every layout, with the page counts the spec states", () => {
		expect(AGENDA_LAYOUT_LABELS).toEqual({
			grid: "Grid",
			editorial: "Editorial",
			timing: "Timing",
			spacious: "Spacious",
		});
		expect(AGENDA_LAYOUT_HINTS).toEqual({
			grid: "One page",
			editorial: "One page",
			timing: "Two pages",
			spacious: "Two pages, larger type",
		});
	});
});
