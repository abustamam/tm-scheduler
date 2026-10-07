import { describe, expect, it } from "vitest";
import { AREA_HEALTH_FIELDS, areaLabel } from "./area-health-fields";

describe("areaLabel (#1116)", () => {
	it("joins the division letter and the area number", () => {
		expect(areaLabel("C", "3")).toBe("C3");
		expect(areaLabel("B", "12")).toBe("B12");
	});

	it("trims both parts so stray whitespace cannot print as a gap", () => {
		expect(areaLabel(" C ", " 3\n")).toBe("C3");
	});
});

describe("AREA_HEALTH_FIELDS (#1116)", () => {
	it("names the six numbers, once each, each with a label and a description", () => {
		expect(AREA_HEALTH_FIELDS.map((f) => f.key)).toEqual([
			"meetings",
			"roleFillRate",
			"attendance",
			"officers",
			"dcp",
			"renewals",
		]);
		for (const field of AREA_HEALTH_FIELDS) {
			expect(field.label.length).toBeGreaterThan(0);
			expect(field.description.length).toBeGreaterThan(0);
		}
	});
});
