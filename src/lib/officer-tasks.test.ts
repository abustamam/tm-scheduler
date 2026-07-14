import { describe, expect, it } from "vitest";
import { buildOfficerHome, COMMON_TASKS } from "./officer-tasks";

describe("buildOfficerHome", () => {
	it("always includes the common band, no sections for no offices", () => {
		const home = buildOfficerHome([]);
		expect(home.common).toEqual(COMMON_TASKS);
		expect(home.sections).toEqual([]);
	});

	it("adds a section per office with tasks, ordered President-first", () => {
		const { sections } = buildOfficerHome(["secretary", "president"]);
		expect(sections.map((s) => s.position)).toEqual(["president", "secretary"]);
		expect(sections[0]?.label).toBe("President");
		expect(sections[0]?.tasks.length).toBeGreaterThan(0);
	});

	it("omits offices that have no dedicated tasks", () => {
		const { sections } = buildOfficerHome([
			"sergeant_at_arms",
			"vp_public_relations",
			"vp_education",
		]);
		expect(sections.map((s) => s.position)).toEqual(["vp_education"]);
	});

	it("surfaces the Treasurer dues tracker (#206)", () => {
		const { sections } = buildOfficerHome(["treasurer"]);
		expect(sections.map((s) => s.position)).toEqual(["treasurer"]);
		expect(sections[0]?.tasks.some((t) => t.to === "/admin/dues")).toBe(true);
	});
});
