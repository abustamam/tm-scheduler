import { describe, expect, it } from "vitest";
import {
	LEVEL_PROXIMITY,
	type ProximityPath,
	projectsLeftCopy,
	proximityDetail,
	selectLevelProximity,
} from "./level-proximity";

function path(over: Partial<ProximityPath> = {}): ProximityPath {
	return {
		pathName: "Presentation Mastery",
		levelsSource: "catalog",
		levels: [],
		workingLevel: 2,
		projectsLeftAtWorkingLevel: 1,
		upNext: [
			{
				projectId: "x",
				level: 2,
				name: "Inspire Your Audience",
				isRequired: true,
			},
		],
		upNextElectives: null,
		...over,
	};
}

function select(
	paths: Record<string, ProximityPath[]>,
	members = Object.keys(paths).map((name) => ({ memberId: name, name })),
	upcoming = new Map<string, Date>(),
) {
	return selectLevelProximity({
		members,
		pathsByMember: new Map(Object.entries(paths)),
		upcomingSpeakerAt: upcoming,
	});
}

describe("selectLevelProximity (#898)", () => {
	it("is close at 1 and 2 projects left, and not at 0 or 3", () => {
		expect(LEVEL_PROXIMITY.maxProjectsLeft).toBe(2);
		const rows = select({
			Zero: [path({ projectsLeftAtWorkingLevel: 0 })],
			One: [path({ projectsLeftAtWorkingLevel: 1 })],
			Two: [path({ projectsLeftAtWorkingLevel: 2 })],
			Three: [path({ projectsLeftAtWorkingLevel: 3 })],
			Done: [path({ workingLevel: null, projectsLeftAtWorkingLevel: 0 })],
		});
		expect(rows.map((r) => [r.name, r.kind, r.projectsLeft])).toEqual([
			["One", "close", 1],
			["Two", "close", 2],
		]);
	});

	it("reports the lowest Base Camp level done but unapproved as awaiting", () => {
		const rows = select({
			Maya: [
				path({
					levelsSource: "basecamp",
					levels: [
						{ level: 1, completed: 4, total: 4, approved: true },
						{ level: 2, completed: 4, total: 4, approved: false },
						{ level: 3, completed: 5, total: 5, approved: false },
						{ level: 4, completed: 0, total: 3, approved: false },
					],
					workingLevel: 4,
					projectsLeftAtWorkingLevel: 3,
				}),
			],
		});
		expect(rows).toEqual([
			{
				memberId: "Maya",
				name: "Maya",
				pathName: "Presentation Mastery",
				level: 2,
				kind: "awaiting_approval",
				projectsLeft: 0,
				projectNames: [],
				electivesToChoose: 0,
			},
		]);
	});

	it("never reports awaiting on the catalog branch, where nothing is approved", () => {
		const rows = select({
			Maya: [
				path({
					levelsSource: "catalog",
					levels: [
						{ level: 1, completed: 4, total: 4, approved: false },
						{ level: 2, completed: 0, total: 4, approved: false },
					],
					workingLevel: 2,
					projectsLeftAtWorkingLevel: 4,
				}),
			],
		});
		expect(rows).toEqual([]);
	});

	it("yields both rows when one level awaits approval and the next is one short", () => {
		const rows = select({
			Maya: [
				path({
					levelsSource: "basecamp",
					levels: [
						{ level: 2, completed: 4, total: 4, approved: false },
						{ level: 3, completed: 3, total: 4, approved: false },
					],
					workingLevel: 3,
					projectsLeftAtWorkingLevel: 1,
					upNext: [],
				}),
			],
		});
		expect(rows.map((r) => [r.kind, r.level, r.projectsLeft])).toEqual([
			["awaiting_approval", 2, 0],
			["close", 3, 1],
		]);
	});

	it("sorts awaiting first, then close by projects left, member, path", () => {
		const awaitingPath = (pathName: string) =>
			path({
				pathName,
				levelsSource: "basecamp",
				levels: [{ level: 1, completed: 4, total: 4, approved: false }],
				workingLevel: null,
				projectsLeftAtWorkingLevel: 0,
			});
		const rows = select({
			Zed: [
				path({ pathName: "B path", projectsLeftAtWorkingLevel: 2 }),
				path({ pathName: "A path", projectsLeftAtWorkingLevel: 2 }),
			],
			Amy: [path({ pathName: "A path", projectsLeftAtWorkingLevel: 2 })],
			Bea: [path({ pathName: "A path", projectsLeftAtWorkingLevel: 1 })],
			Yan: [awaitingPath("B path"), awaitingPath("A path")],
			Cal: [awaitingPath("A path")],
		});
		expect(rows.map((r) => `${r.kind}:${r.name}:${r.pathName}`)).toEqual([
			"awaiting_approval:Cal:A path",
			"awaiting_approval:Yan:A path",
			"awaiting_approval:Yan:B path",
			"close:Bea:A path",
			"close:Amy:A path",
			"close:Zed:A path",
			"close:Zed:B path",
		]);
	});

	it("produces no row for a member who is not on the active roster", () => {
		const rows = select({ Active: [path()], Inactive: [path()] }, [
			{ memberId: "Active", name: "Active" },
		]);
		expect(rows.map((r) => r.name)).toEqual(["Active"]);
	});

	it("carries the names, electives and soonest speaker slot through", () => {
		const at = new Date("2026-10-10T06:30:00Z");
		const rows = select(
			{
				m1: [
					path({
						projectsLeftAtWorkingLevel: 2,
						upNextElectives: {
							chooseCount: 1,
							options: [{ projectId: "e", name: "Active Listening" }],
						},
					}),
				],
				m2: [path()],
			},
			[
				{ memberId: "m1", name: "Maya Chen" },
				{ memberId: "m2", name: "Omar Ali" },
			],
			new Map([["m1", at]]),
		);
		expect(rows[0]).toMatchObject({
			name: "Omar Ali",
			projectNames: ["Inspire Your Audience"],
			electivesToChoose: 0,
		});
		expect(rows[0].upcomingSpeakerAt).toBeUndefined();
		expect(rows[1]).toMatchObject({
			name: "Maya Chen",
			projectsLeft: 2,
			projectNames: ["Inspire Your Audience"],
			electivesToChoose: 1,
			upcomingSpeakerAt: at,
		});
	});
});

describe("projectsLeftCopy (#898)", () => {
	const copy = (projectsLeft: number, projectNames: string[], e = 0) =>
		projectsLeftCopy({ projectsLeft, projectNames, electivesToChoose: e });

	it("names every project when the names account for the count", () => {
		expect(copy(1, ["Inspire Your Audience"])).toBe(
			"1 left: Inspire Your Audience",
		);
		expect(copy(2, ["Inspire Your Audience", "Active Listening"])).toBe(
			"2 left: Inspire Your Audience, Active Listening",
		);
	});

	it("adds electives when names plus electives account for the count", () => {
		expect(copy(2, ["Inspire Your Audience"], 1)).toBe(
			"2 left: Inspire Your Audience and 1 elective",
		);
		expect(copy(2, [], 2)).toBe("2 left: choose 2 electives");
		expect(copy(1, [], 1)).toBe("1 left: choose 1 elective");
	});

	it("gives only the count when the names do not add up to it", () => {
		expect(copy(2, [])).toBe("2 left");
		expect(copy(2, ["Inspire Your Audience"])).toBe("2 left");
		expect(copy(2, ["Inspire Your Audience"], 2)).toBe("2 left");
	});

	it("labels Path Completion by name, never Level 6", () => {
		const line = proximityDetail({
			memberId: "m",
			name: "Maya",
			pathName: "Presentation Mastery",
			level: 6,
			kind: "close",
			projectsLeft: 1,
			projectNames: ["Reflect on Your Path"],
			electivesToChoose: 0,
		});
		expect(line).toBe(
			"Presentation Mastery · Path Completion · 1 left: Reflect on Your Path",
		);
	});
});
