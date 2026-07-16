import { describe, expect, it } from "vitest";
import { buildOfficerHome, COMMON_TASKS, OFFICER_TASKS } from "./officer-tasks";
import { OFFICER_POSITIONS } from "./officers";

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

	it("gives every one of the 8 offices a non-empty section (#269)", () => {
		for (const position of OFFICER_POSITIONS) {
			const { sections } = buildOfficerHome([position]);
			expect(sections.map((s) => s.position)).toEqual([position]);
			expect(sections[0]?.tasks.length).toBeGreaterThan(0);
		}
	});

	it("covers VP PR, Sergeant at Arms, and IPP — no more empty offices (#269)", () => {
		const { sections } = buildOfficerHome([
			"sergeant_at_arms",
			"vp_public_relations",
			"immediate_past_president",
			"vp_education",
		]);
		// Ordered President-first (canonical rank), all four present.
		expect(sections.map((s) => s.position)).toEqual([
			"vp_education",
			"vp_public_relations",
			"sergeant_at_arms",
			"immediate_past_president",
		]);
		for (const s of sections) {
			expect(s.tasks.length).toBeGreaterThan(0);
		}
	});

	it("every OFFICER_TASKS entry has a non-empty task list", () => {
		for (const position of OFFICER_POSITIONS) {
			expect(OFFICER_TASKS[position].length).toBeGreaterThan(0);
		}
	});

	it("surfaces the Treasurer dues tracker (#206)", () => {
		const { sections } = buildOfficerHome(["treasurer"]);
		expect(sections.map((s) => s.position)).toEqual(["treasurer"]);
		expect(sections[0]?.tasks.some((t) => t.to === "/admin/dues")).toBe(true);
	});
});
