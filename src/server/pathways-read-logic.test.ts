import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

import type { DetailProjectRow } from "./pathways-read-logic";
import {
	buildPathViewModel,
	type CatalogProject,
	type SyncedLevel,
	type Win,
} from "./pathways-read-logic";

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

const win = (level: number, name: string, speechTitle = "A speech"): Win => ({
	level,
	name,
	speechTitle,
	deliveredAt: new Date("2026-01-01T00:00:00Z"),
});

const project = (
	level: number,
	name: string,
	isRequired = true,
): CatalogProject => ({ level, name, isRequired });

const dp = (
	level: number,
	name: string,
	complete: boolean,
	isRequired = true,
	speechTitle: string | null = null,
	speechDate: Date | null = null,
): DetailProjectRow => ({
	courseCode: "8701",
	level,
	name,
	isRequired,
	complete,
	speechTitle,
	speechDate,
});

describe("buildPathViewModel", () => {
	it("computes ring %, current level, and per-level chips", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 2, 4, false), lv(3, 0, 4, false)],
			wins: [],
			catalogProjects: [],
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
			wins: [],
			catalogProjects: [],
		});
		expect(vm.ringPercent).toBe(85); // (5+3+3+0)/(5+3+3+2)=11/13→85
		expect(vm.currentLevel).toBe(4);
	});

	it("marks a fully-approved path complete (no current level)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 4, 4, true)],
			wins: [],
			catalogProjects: [],
		});
		expect(vm.ringPercent).toBe(100);
		expect(vm.currentLevel).toBeNull();
		expect(vm.complete).toBe(true);
	});

	it("passes wins through untouched", () => {
		const wins = [win(2, "Evaluation and Feedback"), win(1, "Icebreaker")];
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 2, 4, false)],
			wins,
			catalogProjects: [],
		});
		expect(vm.wins).toEqual(wins);
	});

	it("upNext = current-level catalog projects minus wins (by name)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 2, 4, false)],
			wins: [win(2, "Evaluation and Feedback")],
			catalogProjects: [
				project(1, "Icebreaker"),
				project(2, "Evaluation and Feedback"),
				project(2, "Understanding Your Communication Style"),
				project(3, "A Level 3 Project"),
			],
		});
		expect(vm.currentLevel).toBe(2);
		expect(vm.upNext).toEqual([
			{
				level: 2,
				name: "Understanding Your Communication Style",
				isRequired: true,
			},
		]);
	});

	it("upNext is empty when the path is complete", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 5, 5, true), lv(2, 4, 4, true)],
			wins: [],
			catalogProjects: [
				project(1, "Icebreaker"),
				project(2, "Evaluation and Feedback"),
			],
		});
		expect(vm.complete).toBe(true);
		expect(vm.upNext).toEqual([]);
	});

	describe("bcm branch (detailProjects present)", () => {
		it("wins = all complete projects; speeches enriched, non-speech name-only", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				levels: [lv(1, 5, 5, true), lv(2, 1, 4, false)],
				wins: [], // inference source ignored on the bcm branch
				catalogProjects: [],
				detailProjects: [
					dp(
						1,
						"Ice Breaker",
						true,
						true,
						"My Journey",
						new Date("2025-02-27T08:00:00Z"),
					),
					dp(1, "Manage Projects Successfully", true, true), // leadership, no speech
					dp(2, "Researching a Topic", false, true), // not complete → not a win
				],
				pathLevels: [],
			});
			expect(vm.wins.map((w) => w.name)).toEqual([
				"Ice Breaker",
				"Manage Projects Successfully",
			]);
			const ice = vm.wins.find((w) => w.name === "Ice Breaker");
			expect(ice?.speechTitle).toBe("My Journey");
			expect(ice?.deliveredAt).toEqual(new Date("2025-02-27T08:00:00Z"));
			const leadership = vm.wins.find(
				(w) => w.name === "Manage Projects Successfully",
			);
			expect(leadership?.speechTitle).toBe("");
			expect(leadership?.deliveredAt).toBeNull();
		});

		it("upNext = current-level REQUIRED projects not complete; electives grouped", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				levels: [lv(1, 5, 5, true), lv(3, 1, 4, false)], // current level = 3
				wins: [],
				catalogProjects: [
					project(3, "Deliver Social Speeches", false), // elective, complete below
					project(3, "Persuasive Speaking", false), // elective, remaining
					project(3, "Connect with Storytelling", false), // elective, remaining
					project(3, "Understanding Emotional Intelligence", true), // required, remaining
				],
				detailProjects: [
					dp(3, "Deliver Social Speeches", true, false), // one elective done
				],
				pathLevels: [{ level: 3, minReqElectives: 2 }],
			});
			expect(vm.upNext.map((p) => p.name)).toEqual([
				"Understanding Emotional Intelligence",
			]);
			expect(vm.upNextElectives).toEqual({
				chooseCount: 1,
				options: ["Persuasive Speaking", "Connect with Storytelling"],
			});
		});

		it("no elective group when the level's elective requirement is already met", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				levels: [lv(1, 1, 4, false)],
				wins: [],
				catalogProjects: [
					project(1, "Elective A", false),
					project(1, "Elective B", false),
				],
				detailProjects: [
					dp(1, "Elective A", true, false),
					dp(1, "Elective B", true, false),
				],
				pathLevels: [{ level: 1, minReqElectives: 1 }], // need 1, 2 done
			});
			expect(vm.upNextElectives).toBeNull();
		});

		it("a same-named project completed at another level does not hide the current-level instance", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				levels: [lv(1, 5, 5, true), lv(3, 0, 4, false)], // current level = 3
				wins: [],
				catalogProjects: [
					project(3, "Deliver Social Speeches", false), // L3 elective, NOT complete
					project(3, "Persuasive Speaking", false), // L3 elective, remaining
					project(3, "Understanding Emotional Intelligence", true), // L3 required, remaining
				],
				detailProjects: [
					dp(1, "Deliver Social Speeches", true, false), // complete at L1, not L3
				],
				pathLevels: [{ level: 3, minReqElectives: 1 }],
			});
			// The L1 completion must NOT mark the L3 elective of the same name done.
			expect(vm.upNextElectives).toEqual({
				chooseCount: 1,
				options: ["Deliver Social Speeches", "Persuasive Speaking"],
			});
			// And the required L3 project is still surfaced.
			expect(vm.upNext.map((p) => p.name)).toEqual([
				"Understanding Emotional Intelligence",
			]);
		});
	});

	it("fallback branch (no detailProjects) sets upNextElectives null and keeps inference wins", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			levels: [lv(1, 1, 4, false)],
			wins: [win(1, "Ice Breaker")],
			catalogProjects: [
				project(1, "Ice Breaker"),
				project(1, "Speaking to Inform"),
			],
			// no detailProjects
		});
		expect(vm.upNextElectives).toBeNull();
		expect(vm.wins.map((w) => w.name)).toEqual(["Ice Breaker"]); // inference passthrough
		expect(vm.upNext.map((p) => p.name)).toEqual(["Speaking to Inform"]); // today's logic
	});
});
