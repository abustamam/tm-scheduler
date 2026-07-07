import { describe, expect, it } from "vitest";
import {
	AGENDA_OFFICER_POSITIONS,
	OFFICER_POSITIONS,
	officerPositionLabel,
	officerRank,
	parseOfficerPosition,
} from "./officers";

describe("parseOfficerPosition", () => {
	it("parses the Toastmasters CSV 'Club …' export labels for all 8 officers", () => {
		expect(parseOfficerPosition("Club President")).toBe("president");
		expect(parseOfficerPosition("Club VP Education")).toBe("vp_education");
		expect(parseOfficerPosition("Club VP Membership")).toBe("vp_membership");
		expect(parseOfficerPosition("Club VP PR")).toBe("vp_public_relations");
		expect(parseOfficerPosition("Club Secretary")).toBe("secretary");
		expect(parseOfficerPosition("Club Treasurer")).toBe("treasurer");
		expect(parseOfficerPosition("Club Sergeant at Arms")).toBe(
			"sergeant_at_arms",
		);
		expect(parseOfficerPosition("Immediate Past President")).toBe(
			"immediate_past_president",
		);
	});

	it("does not mistake a VP or past president for the President", () => {
		expect(parseOfficerPosition("VP Education")).toBe("vp_education");
		expect(parseOfficerPosition("Vice President of Membership")).toBe(
			"vp_membership",
		);
		expect(parseOfficerPosition("VP Public Relations")).toBe(
			"vp_public_relations",
		);
		expect(parseOfficerPosition("Immediate Past President")).toBe(
			"immediate_past_president",
		);
	});

	it("tolerates common abbreviations", () => {
		expect(parseOfficerPosition("VPE")).toBe("vp_education");
		expect(parseOfficerPosition("VPM")).toBe("vp_membership");
		expect(parseOfficerPosition("VPPR")).toBe("vp_public_relations");
		expect(parseOfficerPosition("SAA")).toBe("sergeant_at_arms");
		expect(parseOfficerPosition("IPP")).toBe("immediate_past_president");
	});

	it("returns null for blank input", () => {
		expect(parseOfficerPosition("")).toBeNull();
		expect(parseOfficerPosition("   ")).toBeNull();
		expect(parseOfficerPosition(null)).toBeNull();
		expect(parseOfficerPosition(undefined)).toBeNull();
	});

	it("returns null for unparseable offices", () => {
		expect(parseOfficerPosition("Webmaster")).toBeNull();
		expect(parseOfficerPosition("Toastmaster of the Day")).toBeNull();
		expect(parseOfficerPosition("Area Director")).toBeNull();
	});
});

describe("officerRank / labels", () => {
	it("orders the standard line-up President → Immediate Past President", () => {
		const shuffled = [
			"sergeant_at_arms",
			"treasurer",
			"vp_education",
			"immediate_past_president",
			"president",
			"secretary",
			"vp_public_relations",
			"vp_membership",
		] as const;
		const sorted = [...shuffled].sort(
			(a, b) => officerRank(a) - officerRank(b),
		);
		expect(sorted).toEqual([...OFFICER_POSITIONS]);
	});

	it("agenda line-up keeps canonical order but drops Immediate Past President", () => {
		expect(AGENDA_OFFICER_POSITIONS).toEqual([
			"president",
			"vp_education",
			"vp_membership",
			"vp_public_relations",
			"secretary",
			"treasurer",
			"sergeant_at_arms",
		]);
		expect(AGENDA_OFFICER_POSITIONS).not.toContain("immediate_past_president");
	});

	it("gives a human label for each position", () => {
		expect(officerPositionLabel("president")).toBe("President");
		expect(officerPositionLabel("vp_education")).toBe("VP Education");
		expect(officerPositionLabel("sergeant_at_arms")).toBe("Sergeant at Arms");
		expect(officerPositionLabel("immediate_past_president")).toBe(
			"Immediate Past President",
		);
	});
});
