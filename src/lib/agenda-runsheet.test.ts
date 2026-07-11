import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import { buildLegend, expandRunSheet, RUN_OF_SHOW } from "./agenda-runsheet";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

describe("RUN_OF_SHOW template", () => {
	it("is an ordered list of 13 beats", () => {
		expect(RUN_OF_SHOW).toHaveLength(13);
	});

	it("every beat has a positive duration", () => {
		for (const beat of RUN_OF_SHOW) {
			expect(beat.minutes).toBeGreaterThan(0);
		}
	});

	it("role beats reference the club's standard role names", () => {
		const roleNames = RUN_OF_SHOW.filter((b) => b.kind === "role").map(
			(b) => (b as { roleName: string }).roleName,
		);
		expect(roleNames).toContain("Toastmaster of the Day");
		expect(roleNames).toContain("Speaker");
		expect(roleNames).toContain("Evaluator");
		expect(roleNames).toContain("Table Topics Master");
		expect(roleNames).toContain("General Evaluator");
	});
});

describe("buildLegend", () => {
	it("lists functionary roles with their assignees, in input order", () => {
		const slots = [
			slot({ id: "t", roleName: "Timer", assigneeName: "Alice" }),
			slot({ id: "g", roleName: "Grammarian", assigneeName: "Bob" }),
			slot({
				id: "sp",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: "Cara",
			}),
		];
		expect(buildLegend(slots)).toEqual([
			{ role: "Timer", name: "Alice" },
			{ role: "Grammarian", name: "Bob" },
		]);
	});

	it("shows the open placeholder for an unassigned functionary", () => {
		expect(
			buildLegend([slot({ roleName: "Ah-Counter", assigneeName: null })]),
		).toEqual([{ role: "Ah-Counter", name: "— open —" }]);
	});
});

describe("expandRunSheet", () => {
	it("passes event beats through as label-only rows (no marks)", () => {
		const rows = expandRunSheet([]);
		const callToOrder = rows[0];
		expect(callToOrder.who).toBe("Sergeant-at-Arms");
		expect(callToOrder.marks).toBeNull();
		expect(callToOrder.minutes).toBe(1);
	});

	it("event beats always render even with no slots", () => {
		const rows = expandRunSheet([]);
		// 7 event beats in the template render regardless of assignees.
		expect(rows.filter((r) => r.who === "Timer").length).toBe(3);
	});

	it("renders a plain role with its assignee name", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Dana",
			}),
		]);
		expect(rows.some((r) => r.who === "Toastmaster of the Day · Dana")).toBe(
			true,
		);
	});

	it("renders a missing plain role as a label-only row (graceful)", () => {
		const rows = expandRunSheet([]); // no Toastmaster slot
		expect(rows.some((r) => r.who === "Toastmaster of the Day")).toBe(true);
	});

	it("expands speakers by actual slots, numbering when >1, with marks from min/max and duration from max", () => {
		const rows = expandRunSheet([
			slot({
				id: "s1",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
				assigneeName: "Rehanna",
				speechTitle: "Chai",
				projectLevel: "L2",
				minMinutes: 5,
				maxMinutes: 7,
			}),
			slot({
				id: "s2",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 1,
				assigneeName: "Sudheer",
				speechTitle: "Clubs",
				projectLevel: "L4",
				minMinutes: 5,
				maxMinutes: 7,
			}),
		]);
		const sp1 = rows.find((r) => r.who.startsWith("Speaker 1"));
		expect(sp1?.who).toBe("Speaker 1 · Rehanna");
		expect(sp1?.detail).toBe('"Chai" · L2');
		expect(sp1?.minutes).toBe(7);
		expect(sp1?.marks).toEqual({ green: 5, yellow: 6, red: 7 });
		expect(rows.some((r) => r.who === "Speaker 2 · Sudheer")).toBe(true);
	});

	it("uses the open placeholder and fallback duration for an open speaker with no details", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: null,
			}),
		]);
		const sp = rows.find((r) => r.who.startsWith("Speaker"));
		expect(sp?.who).toBe("Speaker · — open —");
		expect(sp?.minutes).toBe(7);
		expect(sp?.marks).toBeNull();
	});

	it("orders evaluators by the speaker they evaluate and labels 'Evaluates X'", () => {
		const slots = [
			slot({
				id: "spA",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
				assigneeName: "A",
			}),
			slot({
				id: "spB",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 1,
				assigneeName: "B",
			}),
			// Evaluator slots given OUT of speaker order; expansion must reorder.
			slot({
				id: "e2",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 0,
				assigneeName: "EvalB",
				evaluatesSlotId: "spB",
				evaluates: { speakerName: "B" },
			}),
			slot({
				id: "e1",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 1,
				assigneeName: "EvalA",
				evaluatesSlotId: "spA",
				evaluates: { speakerName: "A" },
			}),
		];
		const rows = expandRunSheet(slots);
		const evalRows = rows.filter((r) => r.who.startsWith("Evaluator"));
		expect(evalRows[0].who).toBe("Evaluator 1 · EvalA");
		expect(evalRows[0].detail).toBe("Evaluates A");
		expect(evalRows[1].who).toBe("Evaluator 2 · EvalB");
	});
});

describe("expandRunSheet flex marker", () => {
	it("marks exactly one row — the Table Topics row — as flex", () => {
		const rows = expandRunSheet([]);
		const flexed = rows.filter((r) => r.flex === true);
		expect(flexed).toHaveLength(1);
		expect(flexed[0].who).toContain("Table Topics");
	});

	it("does not mark any row when the template has no flex beat", () => {
		const noFlex = RUN_OF_SHOW.map((b) => ({ ...b, flex: undefined }));
		const rows = expandRunSheet([], noFlex);
		expect(rows.some((r) => r.flex === true)).toBe(false);
	});
});
