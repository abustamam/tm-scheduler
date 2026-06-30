import { describe, expect, it } from "vitest";
import {
	buildRoleCounts,
	buildShortCodes,
	generateSlotRows,
	resolveEvaluatorLinks,
	roleAbbrev,
	slotLabel,
} from "./agenda";

describe("generateSlotRows", () => {
	it("generates the correct number of rows with 0-based slotIndex", () => {
		const defs = [{ id: "def-1", defaultCount: 3 }];
		const rows = generateSlotRows(defs, "meeting-1");
		expect(rows).toHaveLength(3);
		expect(rows[0]).toEqual({
			meetingId: "meeting-1",
			roleDefinitionId: "def-1",
			slotIndex: 0,
		});
		expect(rows[1]).toEqual({
			meetingId: "meeting-1",
			roleDefinitionId: "def-1",
			slotIndex: 1,
		});
		expect(rows[2]).toEqual({
			meetingId: "meeting-1",
			roleDefinitionId: "def-1",
			slotIndex: 2,
		});
	});

	it("yields no rows for defaultCount: 0", () => {
		const rows = generateSlotRows(
			[{ id: "def-1", defaultCount: 0 }],
			"meeting-1",
		);
		expect(rows).toHaveLength(0);
	});

	it("flattens multiple defs in order", () => {
		const defs = [
			{ id: "def-a", defaultCount: 2 },
			{ id: "def-b", defaultCount: 1 },
		];
		const rows = generateSlotRows(defs, "meeting-x");
		expect(rows).toHaveLength(3);
		expect(rows[0].roleDefinitionId).toBe("def-a");
		expect(rows[1].roleDefinitionId).toBe("def-a");
		expect(rows[2].roleDefinitionId).toBe("def-b");
	});

	it("returns [] for empty defs", () => {
		expect(generateSlotRows([], "meeting-1")).toEqual([]);
	});
});

describe("buildRoleCounts + slotLabel", () => {
	it("returns bare role name when the role appears only once", () => {
		const slots = [{ roleName: "Toastmaster", slotIndex: 0 }];
		const counts = buildRoleCounts(slots);
		expect(slotLabel({ roleName: "Toastmaster", slotIndex: 0 }, counts)).toBe(
			"Toastmaster",
		);
	});

	it("numbers repeated roles starting at 1", () => {
		const slots = [
			{ roleName: "Speaker", slotIndex: 0 },
			{ roleName: "Speaker", slotIndex: 1 },
			{ roleName: "Speaker", slotIndex: 2 },
		];
		const counts = buildRoleCounts(slots);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 0 }, counts)).toBe(
			"Speaker 1",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 1 }, counts)).toBe(
			"Speaker 2",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 2 }, counts)).toBe(
			"Speaker 3",
		);
	});

	it("handles mixed single and repeated roles", () => {
		const slots = [
			{ roleName: "Toastmaster", slotIndex: 0 },
			{ roleName: "Speaker", slotIndex: 0 },
			{ roleName: "Speaker", slotIndex: 1 },
		];
		const counts = buildRoleCounts(slots);
		expect(slotLabel({ roleName: "Toastmaster", slotIndex: 0 }, counts)).toBe(
			"Toastmaster",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 0 }, counts)).toBe(
			"Speaker 1",
		);
		expect(slotLabel({ roleName: "Speaker", slotIndex: 1 }, counts)).toBe(
			"Speaker 2",
		);
	});
});

describe("resolveEvaluatorLinks", () => {
	it("populates evaluates when evaluatesSlotId matches a speaker row", () => {
		const rows = [
			{
				id: "slot-speaker",
				evaluatesSlotId: null,
				assigneeName: "Alice",
				speechTitle: "My Ice Breaker",
			},
			{
				id: "slot-evaluator",
				evaluatesSlotId: "slot-speaker",
				assigneeName: "Bob",
				speechTitle: null,
			},
		];
		const result = resolveEvaluatorLinks(rows);
		const evaluatorRow = result.find((r) => r.id === "slot-evaluator");
		expect(evaluatorRow?.evaluates).toEqual({
			slotId: "slot-speaker",
			speakerName: "Alice",
			speechTitle: "My Ice Breaker",
		});
	});

	it("sets evaluates to null when evaluatesSlotId is null", () => {
		const rows = [
			{
				id: "slot-speaker",
				evaluatesSlotId: null,
				assigneeName: "Alice",
				speechTitle: "My Ice Breaker",
			},
		];
		const result = resolveEvaluatorLinks(rows);
		expect(result[0].evaluates).toBeNull();
	});

	it("sets evaluates to null for a dangling evaluatesSlotId (no matching row)", () => {
		const rows = [
			{
				id: "slot-evaluator",
				evaluatesSlotId: "nonexistent-slot",
				assigneeName: "Bob",
				speechTitle: null,
			},
		];
		const result = resolveEvaluatorLinks(rows);
		expect(result[0].evaluates).toBeNull();
	});

	it("preserves all other fields on the row", () => {
		const rows = [
			{
				id: "slot-1",
				evaluatesSlotId: null,
				assigneeName: "Alice",
				speechTitle: "Hello",
				extraField: "preserved",
			},
		];
		const result = resolveEvaluatorLinks(rows);
		expect(result[0].extraField).toBe("preserved");
	});
});

describe("roleAbbrev", () => {
	it("uses initials for multi-word names", () => {
		expect(roleAbbrev("General Evaluator")).toBe("GE");
		expect(roleAbbrev("Table Topics Master")).toBe("TTM");
	});
	it("drops stopwords", () => {
		expect(roleAbbrev("Toastmaster of the Day")).toBe("TD");
	});
	it("uses first four letters for single-word names", () => {
		expect(roleAbbrev("Speaker")).toBe("Spea");
		expect(roleAbbrev("Timer")).toBe("Time");
		expect(roleAbbrev("Grammarian")).toBe("Gram");
	});
});

describe("buildShortCodes", () => {
	it("numbers repeated roles and keeps singletons unnumbered", () => {
		const codes = buildShortCodes([
			{ roleDefinitionId: "s", slotIndex: 0, name: "Speaker" },
			{ roleDefinitionId: "s", slotIndex: 1, name: "Speaker" },
			{ roleDefinitionId: "s", slotIndex: 2, name: "Speaker" },
			{ roleDefinitionId: "t", slotIndex: 0, name: "Timer" },
		]);
		expect(codes.get("s:0")).toBe("Spea1");
		expect(codes.get("s:2")).toBe("Spea3");
		expect(codes.get("t:0")).toBe("Time");
	});
	it("disambiguates two different names that share a base code", () => {
		const codes = buildShortCodes([
			{ roleDefinitionId: "a", slotIndex: 0, name: "Tall Tales" },
			{ roleDefinitionId: "b", slotIndex: 0, name: "Topic Time" },
		]);
		expect(codes.get("a:0")).toBe("TT");
		expect(codes.get("b:0")).toBe("TT#2");
	});
});
