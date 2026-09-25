import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

import { PATH_COMPLETION_LEVEL } from "#/lib/pathways-catalog";

import type { DetailProjectRow, MarkRow } from "./pathways-read-logic";
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

// A stable synthetic project id so the catalog, the /detail mirror and the
// manual marks all agree on which project they mean — the real ids are uuids
// from `pathways_projects`, and the union logic keys on exactly this identity.
const pid = (level: number, name: string) => `p:${level}:${name}`;

const win = (level: number, name: string, speechTitle = "A speech"): Win => ({
	projectId: pid(level, name),
	level,
	name,
	speechTitle,
	deliveredAt: new Date("2026-01-01T00:00:00Z"),
	markedHere: false,
	awaitingProcessing: false,
});

const project = (
	level: number,
	name: string,
	isRequired = true,
): CatalogProject => ({
	projectId: pid(level, name),
	level,
	name,
	isRequired,
	series: null,
});

const dp = (
	level: number,
	name: string,
	complete: boolean,
	isRequired = true,
	speechTitle: string | null = null,
	speechDate: Date | null = null,
): DetailProjectRow => ({
	projectId: pid(level, name),
	courseCode: "8701",
	level,
	name,
	isRequired,
	complete,
	speechTitle,
	speechDate,
});

const mark = (level: number, name: string, isRequired = true): MarkRow => ({
	projectId: pid(level, name),
	courseCode: "8701",
	level,
	name,
	isRequired,
	markedAt: new Date("2026-02-01T00:00:00Z"),
});

describe("buildPathViewModel", () => {
	it("computes ring %, current level, and per-level chips", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
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
			status: "legacy",
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
			status: "current",
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
			status: "current",
			levels: [lv(1, 5, 5, true), lv(2, 2, 4, false)],
			wins,
			catalogProjects: [],
		});
		expect(vm.wins).toEqual(wins);
	});

	// Was "upNext = current-level catalog projects minus wins (by name)" until
	// #456 removed that inference. `currentLevel` is still derived and still
	// asserted; what changed is that this branch no longer publishes a
	// "what's left" list it has no basis for.
	it("still resolves the current level, but publishes no up-next (#456)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
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
		expect(vm.upNext).toEqual([]);
	});

	it("upNext is empty when the path is complete", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
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
				status: "current",
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
				status: "current",
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
			expect(vm.upNextElectives?.chooseCount).toBe(1);
			expect(vm.upNextElectives?.options.map((o) => o.name)).toEqual([
				"Persuasive Speaking",
				"Connect with Storytelling",
			]);
		});

		it("no elective group when the level's elective requirement is already met", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				status: "current",
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
				status: "current",
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
			// Matching is by project id now, so this holds structurally rather than
			// by the name-plus-level check it used to need.
			expect(vm.upNextElectives?.chooseCount).toBe(1);
			expect(vm.upNextElectives?.options.map((o) => o.name)).toEqual([
				"Deliver Social Speeches",
				"Persuasive Speaking",
			]);
			// And the required L3 project is still surfaced.
			expect(vm.upNext.map((p) => p.name)).toEqual([
				"Understanding Emotional Intelligence",
			]);
		});
	});

	it("fallback branch keeps inference wins but presents NO up-next (#456)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [lv(1, 1, 4, false)],
			wins: [win(1, "Ice Breaker")],
			catalogProjects: [
				project(1, "Ice Breaker"),
				project(1, "Speaking to Inform"),
			],
			// no detailProjects
		});
		expect(vm.upNextElectives).toBeNull();
		// Wins stay: every row is a speech this member really delivered.
		expect(vm.wins.map((w) => w.name)).toEqual(["Ice Breaker"]); // inference passthrough
		// Up-next does NOT: "catalog minus delivered speech names" answers "has
		// this been touched", not "is it finished" (#456).
		expect(vm.upNext).toEqual([]);
	});

	// The motivating case. `Evaluation and Feedback` takes three assignments —
	// speak, evaluate someone else, speak again applying the feedback — so one
	// delivered speech used to make it vanish from up-next with two outstanding,
	// while `wins` listed it and the screen read as complete.
	it("does not present a multi-assignment project as finished after one speech (#456)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [lv(1, 1, 4, false)],
			wins: [win(1, "Evaluation and Feedback")],
			catalogProjects: [
				project(1, "Ice Breaker"),
				project(1, "Evaluation and Feedback"),
			],
			// no detailProjects — the summary-only club this branch serves
		});

		// It is listed as a delivered speech…
		expect(vm.wins.map((w) => w.name)).toEqual(["Evaluation and Feedback"]);
		// …and NOT silently dropped from a "what's left" list that cannot know.
		// Before #456 this asserted ["Ice Breaker"], i.e. the project with two
		// assignments outstanding had disappeared.
		expect(vm.upNext).toEqual([]);
	});

	// A leadership project is not a speech, so no amount of speech data can
	// evidence it — subtracting win names from the catalog is not a weak signal
	// here, it is an unrelated one.
	it("never infers up-next for non-speech projects (#456)", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [lv(3, 0, 4, false)],
			wins: [win(3, "Ice Breaker")],
			catalogProjects: [
				project(3, "High Performance Leadership"),
				project(3, "Manage Successful Events"),
			],
		});
		expect(vm.upNext).toEqual([]);
	});
});

// The whole point of #419: a club with no Base Camp still gets a real path.
describe("manual progress marks (#419)", () => {
	const catalog = [
		project(1, "Ice Breaker"),
		project(1, "Evaluation and Feedback"),
		project(2, "Understanding Your Style"),
		project(3, "Understanding Emotional Intelligence"),
		project(3, "Persuasive Speaking", false),
		project(3, "Connect with Storytelling", false),
	];
	const pathLevels = [
		{ level: 1, minReqElectives: 0 },
		{ level: 2, minReqElectives: 0 },
		{ level: 3, minReqElectives: 2 },
	];

	// Before this, `pathwaysForPerson` inner-joined path_level_progress, so this
	// enrollment produced NOTHING and the dashboard claimed the club hadn't
	// synced — after the member had explicitly declared a path.
	it("derives levels from the catalog when Base Camp has never spoken", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [], // no path_level_progress at all
			wins: [],
			catalogProjects: catalog,
			pathLevels,
			marks: [mark(1, "Ice Breaker")],
		});
		expect(vm.levelsSource).toBe("catalog");
		expect(vm.hasBasecamp).toBe(false);
		expect(vm.levels).toEqual([
			{ level: 1, completed: 1, total: 2, approved: false },
			{ level: 2, completed: 0, total: 1, approved: false },
			// 1 required + 2 required electives — TI's real requirement, not a
			// count of the pool.
			{ level: 3, completed: 0, total: 3, approved: false },
		]);
		expect(vm.currentLevel).toBe(1);
		expect(vm.wins.map((w) => w.name)).toEqual(["Ice Breaker"]);
	});

	// Only Base Camp approves a level. Inferring approval from marks would be
	// exactly the over-crediting explicit marks exist to prevent.
	it("never reports a path complete off marks alone", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [],
			wins: [],
			catalogProjects: [project(1, "Ice Breaker")],
			pathLevels: [{ level: 1, minReqElectives: 0 }],
			marks: [mark(1, "Ice Breaker")],
		});
		expect(vm.levels.every((l) => !l.approved)).toBe(true);
		expect(vm.complete).toBe(false);
		expect(vm.ringPercent).toBe(100); // 1 of 1 marked — the count is honest
	});

	it("drops a marked project off what's next", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [lv(1, 2, 2, true), lv(2, 0, 1, false), lv(3, 0, 3, false)],
			wins: [],
			catalogProjects: catalog,
			pathLevels,
			marks: [mark(2, "Understanding Your Style")],
		});
		expect(vm.currentLevel).toBe(2);
		expect(vm.upNext).toEqual([]);
	});

	it("counts a marked elective against the choose-N requirement", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [lv(1, 2, 2, true), lv(2, 1, 1, true), lv(3, 0, 3, false)],
			wins: [],
			catalogProjects: catalog,
			pathLevels,
			marks: [mark(3, "Persuasive Speaking", false)],
		});
		expect(vm.upNextElectives?.chooseCount).toBe(1);
		expect(vm.upNextElectives?.options.map((o) => o.name)).toEqual([
			"Connect with Storytelling",
		]);
	});

	describe("the two sources are never merged", () => {
		it("flags marked-but-not-in-Base-Camp as awaiting processing", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				status: "current",
				levels: [lv(1, 1, 2, false)],
				wins: [],
				catalogProjects: catalog,
				pathLevels,
				detailProjects: [
					dp(1, "Ice Breaker", true),
					dp(1, "Evaluation and Feedback", false),
				],
				marks: [mark(1, "Evaluation and Feedback")],
			});
			const byName = new Map(vm.wins.map((w) => [w.name, w]));
			// Base Camp's own — nothing pending about it.
			expect(byName.get("Ice Breaker")?.awaitingProcessing).toBe(false);
			expect(byName.get("Ice Breaker")?.markedHere).toBe(false);
			// Done here, Base Camp hasn't caught up. Not a conflict.
			expect(byName.get("Evaluation and Feedback")?.awaitingProcessing).toBe(
				true,
			);
			expect(byName.get("Evaluation and Feedback")?.markedHere).toBe(true);
		});

		// A club with no /detail has no per-project verdict from Base Camp, so
		// there is nothing for a mark to be "awaiting".
		it("never says awaiting when Base Camp has no per-project verdict", () => {
			const vm = buildPathViewModel({
				courseCode: "8701",
				pathName: "Presentation Mastery",
				status: "current",
				levels: [lv(1, 1, 2, false)], // summary counts only
				wins: [],
				catalogProjects: catalog,
				pathLevels,
				marks: [mark(1, "Ice Breaker")],
			});
			expect(vm.hasBasecamp).toBe(false);
			expect(vm.wins[0].awaitingProcessing).toBe(false);
			// Base Camp still owns the levels — its counts are real data.
			expect(vm.levelsSource).toBe("basecamp");
		});

		it("keeps Base Camp's completion after the mark is removed", () => {
			const withMark = {
				courseCode: "8701",
				pathName: "Presentation Mastery",
				status: "current" as const,
				levels: [lv(1, 1, 2, false)],
				wins: [],
				catalogProjects: catalog,
				pathLevels,
				detailProjects: [dp(1, "Ice Breaker", true)],
			};
			const marked = buildPathViewModel({
				...withMark,
				marks: [mark(1, "Ice Breaker")],
			});
			const unmarked = buildPathViewModel({ ...withMark, marks: [] });
			expect(marked.wins.map((w) => w.name)).toEqual(["Ice Breaker"]);
			expect(unmarked.wins.map((w) => w.name)).toEqual(["Ice Breaker"]);
			expect(unmarked.wins[0].markedHere).toBe(false);
		});
	});

	// #419: "Completed projects, with their speeches where a speeches.project_id
	// links one." A mark on its own has no speech; the delivered-speech row does.
	it("attaches a delivered speech to a mark that has one", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [],
			wins: [win(1, "Ice Breaker", "My First Speech")],
			catalogProjects: catalog,
			pathLevels,
			marks: [mark(1, "Ice Breaker")],
		});
		expect(vm.wins[0].speechTitle).toBe("My First Speech");
		expect(vm.wins[0].deliveredAt).toEqual(new Date("2026-01-01T00:00:00Z"));
	});
});

// #898: `currentLevel` is "lowest NOT APPROVED", and on the catalog branch
// nothing is ever approved, so it was Level 1 forever and "Up next" with it.
// `workingLevel` is "lowest with projects LEFT", counted per source.
describe("workingLevel (#898)", () => {
	const L1 = [
		project(1, "Ice Breaker"),
		project(1, "Evaluation and Feedback"),
		project(1, "Researching and Presenting"),
		project(1, "Writing a Speech with Purpose"),
	];
	const L2 = [
		project(2, "Understanding Your Communication Style"),
		project(2, "Introduction to Toastmasters Mentoring"),
		project(2, "Effective Body Language", false),
		project(2, "Active Listening", false),
	];
	const catalogPathLevels = [
		{ level: 1, minReqElectives: 0 },
		{ level: 2, minReqElectives: 1 },
	];
	const catalogPath = (marks: MarkRow[], catalogProjects = [...L1, ...L2]) =>
		buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [],
			wins: [],
			catalogProjects,
			pathLevels: catalogPathLevels,
			marks,
		});

	it("moves to Level 2 once Level 1 is fully marked, while currentLevel stays 1", () => {
		const vm = catalogPath(L1.map((p) => mark(1, p.name)));
		expect(vm.levelsSource).toBe("catalog");
		expect(vm.currentLevel).toBe(1);
		expect(vm.workingLevel).toBe(2);
		// 2 required + 1 elective to choose.
		expect(vm.projectsLeftAtWorkingLevel).toBe(3);
		expect(vm.upNext.map((p) => p.name)).toEqual([
			"Understanding Your Communication Style",
			"Introduction to Toastmasters Mentoring",
		]);
		expect(vm.upNextElectives?.chooseCount).toBe(1);
	});

	// Review of #898: the catalog arm sends a zero-mark path down the
	// project-level branch, which built wins from completions only. A member
	// with a delivered, linked Ice Breaker and nothing marked lost "Your wins".
	it("keeps delivered speeches as wins on a catalog path with zero marks", () => {
		const delivered = win(1, "Ice Breaker", "My First Speech");
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [],
			wins: [delivered],
			catalogProjects: [...L1, ...L2],
			pathLevels: catalogPathLevels,
			marks: [],
		});
		expect(vm.wins).toEqual([delivered]);
		// A delivered speech is not a completion (#420), so Up next still lists it.
		expect(vm.workingLevel).toBe(1);
		expect(vm.upNext.map((p) => p.name)).toContain("Ice Breaker");
	});

	it("still lists only completions once the path has marks", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [],
			wins: [win(1, "Ice Breaker", "My First Speech")],
			catalogProjects: [...L1, ...L2],
			pathLevels: catalogPathLevels,
			marks: [mark(1, "Evaluation and Feedback")],
		});
		expect(vm.wins.map((w) => w.name)).toEqual(["Evaluation and Feedback"]);
	});

	it("gives a catalog path with zero marks Level 1 and a non-empty Up next", () => {
		// Before, zero marks fell through to the summary-sync fallback, whose
		// up-next is empty by design (#456) — so a newly declared path had none.
		const vm = catalogPath([]);
		expect(vm.workingLevel).toBe(1);
		expect(vm.projectsLeftAtWorkingLevel).toBe(4);
		expect(vm.upNext.map((p) => p.name)).toEqual(L1.map((p) => p.name));
	});

	it("does not let extra electives hide an unfinished required project", () => {
		const catalog = [
			project(1, "Ice Breaker"),
			project(3, "Persuasive Speaking"),
			project(3, "Elective A", false),
			project(3, "Elective B", false),
			project(3, "Elective C", false),
		];
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [],
			wins: [],
			catalogProjects: catalog,
			pathLevels: [
				{ level: 1, minReqElectives: 0 },
				{ level: 3, minReqElectives: 2 },
			],
			marks: [
				mark(1, "Ice Breaker"),
				mark(3, "Elective A", false),
				mark(3, "Elective B", false),
				mark(3, "Elective C", false),
			],
		});
		expect(vm.workingLevel).toBe(3);
		// The naive count said 3 of 3 marked, i.e. 0 left.
		expect(vm.projectsLeftAtWorkingLevel).toBe(1);
		// And the ring's level agrees: 1 required + 2 electives, 2 of them done.
		expect(vm.levels.find((l) => l.level === 3)).toEqual({
			level: 3,
			completed: 2,
			total: 3,
			approved: false,
		});
		expect(vm.upNext.map((p) => p.name)).toEqual(["Persuasive Speaking"]);
		expect(vm.upNextElectives).toBeNull();
	});

	it("reaches Path Completion on the catalog branch only after levels 1–5", () => {
		const catalog = [
			...[1, 2, 3, 4, 5].map((n) => project(n, `Level ${n} project`)),
			project(PATH_COMPLETION_LEVEL, "Reflect on Your Path"),
		];
		const allFive = [1, 2, 3, 4, 5].map((n) => mark(n, `Level ${n} project`));
		// Legacy, so Levels 4/5 carry no Education Series requirement (#921) and
		// this stays a test of Path Completion alone; the series half is below.
		const at = (marks: MarkRow[]) =>
			buildPathViewModel({
				courseCode: "8705",
				pathName: "Strategic Relationships",
				status: "legacy",
				levels: [],
				wins: [],
				catalogProjects: catalog,
				pathLevels: [],
				marks,
			});

		// Level 4 open: Path Completion is not considered, though it is open too.
		expect(at(allFive.filter((m) => m.level !== 4)).workingLevel).toBe(4);

		const inCompletion = at(allFive);
		expect(inCompletion.workingLevel).toBe(PATH_COMPLETION_LEVEL);
		expect(inCompletion.projectsLeftAtWorkingLevel).toBe(1);
		expect(inCompletion.upNext.map((p) => p.name)).toEqual([
			"Reflect on Your Path",
		]);

		const done = at([
			...allFive,
			mark(PATH_COMPLETION_LEVEL, "Reflect on Your Path"),
		]);
		expect(done.workingLevel).toBeNull();
		expect(done.projectsLeftAtWorkingLevel).toBe(0);
		expect(done.upNext).toEqual([]);
	});

	it("is null on a Base Camp path with levels 1–5 done, even unapproved", () => {
		// Base Camp's summary does not carry Path Completion, so there is no
		// count to make it the working level.
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [1, 2, 3, 4, 5].map((n) => lv(n, 3, 3, n < 5)),
			wins: [],
			catalogProjects: [project(PATH_COMPLETION_LEVEL, "Reflect on Your Path")],
			pathLevels: [],
			marks: [],
		});
		expect(vm.currentLevel).toBe(5);
		expect(vm.workingLevel).toBeNull();
		expect(vm.projectsLeftAtWorkingLevel).toBe(0);
		expect(vm.upNext).toEqual([]);
	});

	it("takes Base Camp's counts as authoritative and does not recount from marks", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			levels: [lv(1, 2, 4, false)],
			wins: [],
			catalogProjects: L1,
			pathLevels: catalogPathLevels,
			// Every Level 1 project marked here, but Base Camp says 2 of 4.
			marks: L1.map((p) => mark(1, p.name)),
		});
		expect(vm.workingLevel).toBe(1);
		expect(vm.projectsLeftAtWorkingLevel).toBe(2);
		// Names come from the marks, so none are left to name.
		expect(vm.upNext).toEqual([]);
	});

	it("skips a Base Camp level that is done but unapproved, and one that is approved", () => {
		const vm = buildPathViewModel({
			courseCode: "8701",
			pathName: "Presentation Mastery",
			status: "current",
			// Level 1 approved on short counts; Level 2 done, awaiting approval.
			levels: [lv(1, 3, 4, true), lv(2, 4, 4, false), lv(3, 1, 3, false)],
			wins: [],
			catalogProjects: [
				project(3, "Persuasive Speaking"),
				project(3, "Connect with Storytelling"),
			],
			detailProjects: [dp(3, "Persuasive Speaking", true)],
			pathLevels: [],
		});
		expect(vm.currentLevel).toBe(2);
		expect(vm.workingLevel).toBe(3);
		expect(vm.projectsLeftAtWorkingLevel).toBe(2);
		expect(vm.upNext.map((p) => p.name)).toEqual(["Connect with Storytelling"]);
	});
});

/**
 * Education Series presentations (#921). Rows with `isRequired: false` and a
 * `series` — not electives. On a current path, Levels 4 and 5 each require one
 * presentation from two series (`seriesRequiredAt`).
 */
describe("Education Series (#921)", () => {
	const seriesProject = (
		level: number,
		name: string,
		series: CatalogProject["series"],
	): CatalogProject => ({ ...project(level, name, false), series });
	const seriesMark = (level: number, name: string): MarkRow =>
		mark(level, name, false);

	const L4 = [
		project(4, "Manage Change"),
		project(4, "Building a Social Media Presence", false),
		project(4, "Write a Compelling Blog", false),
		seriesProject(4, "Finding New Members", "successful_club"),
		seriesProject(4, "Closing the Sale", "successful_club"),
		seriesProject(4, "Beginning Your Speech", "better_speaker"),
		seriesProject(4, "Concluding Your Speech", "better_speaker"),
	];
	const L5 = [
		project(5, "Lead in Your Club"),
		project(5, "Moderate a Panel Discussion", false),
		seriesProject(5, "Moments of Truth", "successful_club"),
		seriesProject(5, "Building a Team", "leadership_excellence"),
	];
	const SERIES_TITLES = [...L4, ...L5]
		.filter((p) => p.series !== null)
		.map((p) => p.name);
	const levelsThrough3 = [1, 2, 3].map((n) => project(n, `Level ${n} project`));
	const pathLevels = [
		{ level: 1, minReqElectives: 0 },
		{ level: 2, minReqElectives: 0 },
		{ level: 3, minReqElectives: 0 },
		{ level: 4, minReqElectives: 1 },
		{ level: 5, minReqElectives: 1 },
	];
	const build = (
		marks: MarkRow[],
		status: "current" | "legacy" = "current",
		levels: SyncedLevel[] = [],
	) =>
		buildPathViewModel({
			courseCode: "8711",
			pathName: "Engaging Humor",
			status,
			levels,
			wins: [],
			catalogProjects: [...levelsThrough3, ...L4, ...L5],
			pathLevels,
			marks,
		});
	const throughL3 = [1, 2, 3].map((n) => mark(n, `Level ${n} project`));

	it("keeps series titles out of upNextElectives and leaves chooseCount alone", () => {
		const vm = build(throughL3);
		expect(vm.workingLevel).toBe(4);
		expect(vm.upNextElectives?.chooseCount).toBe(1);
		const offered = vm.upNextElectives?.options.map((o) => o.name) ?? [];
		expect(offered).toEqual([
			"Building a Social Media Presence",
			"Write a Compelling Blog",
		]);
		for (const title of SERIES_TITLES) expect(offered).not.toContain(title);
		// And a series row is never listed as a required "Up next" project.
		expect(vm.upNext.map((p) => p.name)).toEqual(["Manage Change"]);
	});

	it("does not let a completed series presentation stand in for the elective", () => {
		const vm = build([...throughL3, seriesMark(4, "Finding New Members")]);
		expect(vm.upNextElectives?.chooseCount).toBe(1);
	});

	it("counts L4 and L5 as required + 1 elective + 2 series = 4 on a never-synced current path", () => {
		const vm = build([]);
		expect(vm.levelsSource).toBe("catalog");
		expect(vm.levels.map((l) => [l.level, l.total])).toEqual([
			[1, 1],
			[2, 1],
			[3, 1],
			[4, 4],
			[5, 4],
		]);
	});

	it("leaves every level unchanged on a legacy path", () => {
		const vm = build([], "legacy");
		expect(vm.levels.map((l) => [l.level, l.total])).toEqual([
			[1, 1],
			[2, 1],
			[3, 1],
			[4, 2],
			[5, 2],
		]);
	});

	it("counts two presentations from one series once", () => {
		const vm = build([
			...throughL3,
			seriesMark(4, "Beginning Your Speech"),
			seriesMark(4, "Concluding Your Speech"),
		]);
		expect(vm.levels.find((l) => l.level === 4)).toEqual({
			level: 4,
			completed: 1,
			total: 4,
			approved: false,
		});
		// Required, elective and Successful Club still open.
		expect(vm.projectsLeftAtWorkingLevel).toBe(3);
	});

	it("closes Level 4 only once both series have a presentation", () => {
		const l4Done = [
			mark(4, "Manage Change"),
			mark(4, "Write a Compelling Blog", false),
			seriesMark(4, "Beginning Your Speech"),
		];
		const missingClub = build([...throughL3, ...l4Done]);
		expect(missingClub.workingLevel).toBe(4);
		expect(missingClub.projectsLeftAtWorkingLevel).toBe(1);

		const allMet = build([
			...throughL3,
			...l4Done,
			seriesMark(4, "Closing the Sale"),
		]);
		expect(allMet.levels.find((l) => l.level === 4)?.completed).toBe(4);
		expect(allMet.workingLevel).toBe(5);
	});

	it("leaves Base-Camp-sourced levels exactly as Base Camp reported them", () => {
		const reported = [
			lv(1, 5, 5, true),
			lv(2, 3, 3, true),
			lv(3, 3, 3, true),
			lv(4, 1, 2, false),
			lv(5, 0, 2, false),
		];
		const vm = build(
			[seriesMark(4, "Finding New Members")],
			"current",
			reported.map((l) => ({ ...l })),
		);
		expect(vm.levelsSource).toBe("basecamp");
		expect(vm.levels).toEqual(reported);
	});
});
