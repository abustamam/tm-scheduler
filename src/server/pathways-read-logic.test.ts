import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

import { buildPathViewModel, type SyncedLevel } from "./pathways-read-logic";

const lv = (
	level: number,
	completed: number,
	total: number,
	approved: boolean,
): SyncedLevel => ({
	level,
	completed,
	total,
	approved,
});

describe("buildPathViewModel", () => {
	it("computes ring %, current level, and per-level chips", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 2, 4, false), lv(3, 0, 4, false)],
		});
		expect(vm.pathName).toBe("Presentation Mastery");
		expect(vm.ringPercent).toBe(54); // (5+2+0)/(5+4+4)=7/13→54
		expect(vm.currentLevel).toBe(2);
		expect(vm.levels).toHaveLength(3);
		expect(vm.levels[0]).toEqual({
			level: 1,
			completed: 5,
			total: 5,
			approved: true,
		});
	});

	it("caps completed>total in the ring and reports the current level", () => {
		const vm = buildPathViewModel({
			courseCode: "8705",
			pathName: "Strategic Relationships",
			levels: [
				lv(1, 5, 5, true),
				lv(2, 3, 3, true),
				lv(3, 7, 3, true),
				lv(4, 0, 2, false),
			],
		});
		expect(vm.ringPercent).toBe(85); // (5+3+3+0)/(5+3+3+2)=11/13→85
		expect(vm.currentLevel).toBe(4);
	});

	it("marks a fully-approved path complete (no current level)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 4, 4, true)],
		});
		expect(vm.ringPercent).toBe(100);
		expect(vm.currentLevel).toBeNull();
		expect(vm.complete).toBe(true);
	});
});
