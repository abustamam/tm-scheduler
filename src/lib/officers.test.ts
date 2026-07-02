import { describe, expect, it } from "vitest";
import { officerRank } from "./officers";

describe("officerRank", () => {
	it("orders the standard officer line-up President → Sergeant-at-Arms", () => {
		const offices = [
			"Sergeant-at-Arms",
			"Treasurer",
			"VP Education",
			"President",
			"Secretary",
			"VP Public Relations",
			"VP Membership",
		];
		const sorted = [...offices].sort((a, b) => officerRank(a) - officerRank(b));
		expect(sorted).toEqual([
			"President",
			"VP Education",
			"VP Membership",
			"VP Public Relations",
			"Secretary",
			"Treasurer",
			"Sergeant-at-Arms",
		]);
	});

	it("does not mistake a VP for the President", () => {
		expect(officerRank("VP Education")).toBeGreaterThan(
			officerRank("President"),
		);
		expect(officerRank("Vice President of Membership")).toBe(2);
	});

	it("tolerates common abbreviations", () => {
		expect(officerRank("VPE")).toBe(1);
		expect(officerRank("VPM")).toBe(2);
		expect(officerRank("SAA")).toBe(6);
	});

	it("sorts unrecognized offices last", () => {
		expect(officerRank("Webmaster")).toBeGreaterThan(officerRank("Treasurer"));
	});
});
