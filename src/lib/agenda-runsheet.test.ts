import { describe, expect, it } from "vitest";
import { RUN_OF_SHOW, buildLegend } from "./agenda-runsheet";
import type { AgendaSlot } from "./agenda-runsheet";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s", roleName: "Timer", category: "functionary", isSpeakerRole: false,
		slotIndex: 0, assigneeName: null, speechTitle: null, projectLevel: null,
		minMinutes: null, maxMinutes: null, evaluatesSlotId: null, evaluates: null,
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
			slot({ id: "sp", roleName: "Speaker", category: "speaker", isSpeakerRole: true, assigneeName: "Cara" }),
		];
		expect(buildLegend(slots)).toEqual([
			{ role: "Timer", name: "Alice" },
			{ role: "Grammarian", name: "Bob" },
		]);
	});

	it("shows the open placeholder for an unassigned functionary", () => {
		expect(buildLegend([slot({ roleName: "Ah-Counter", assigneeName: null })])).toEqual([
			{ role: "Ah-Counter", name: "— open —" },
		]);
	});
});
