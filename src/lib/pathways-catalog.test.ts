/**
 * Locks the catalog to what toastmasters.org publishes (#412).
 *
 * The useful property here is that the path pages are self-checking. Each page
 * prints that path's *own* elective options, which TI derives the same way
 * `buildPath` does — the standard pool minus that path's required projects. So
 * the published elective count is an independent check on the required lists:
 * get a required project wrong, or misspell one, and the derived count stops
 * matching the page.
 *
 * Counts below were read from all 11 path pages on 2026-07-27. If TI revises the
 * curriculum these tests fail, which is the point — the pools are the part of
 * the catalog no Base Camp sync can ever verify (unchosen electives never arrive
 * from Base Camp), so this is the only automated guard they get.
 */
import { describe, expect, it } from "vitest";
import {
	levelLabel,
	PATH_COMPLETION_LEVEL,
	PATHWAYS_CATALOG,
} from "./pathways-catalog";

/** courseCode → [name, status, L3 electives, L4 electives, L5 electives] */
const PUBLISHED: Record<
	string,
	[string, "current" | "legacy", number, number, number]
> = {
	"8700": ["Motivational Strategies", "current", 14, 8, 6],
	"8701": ["Presentation Mastery", "current", 14, 7, 5],
	"8702": ["Leadership Development", "legacy", 15, 8, 6],
	"8703": ["Innovative Planning", "legacy", 14, 7, 5],
	"8704": ["Visionary Communication", "current", 15, 8, 6],
	"8705": ["Strategic Relationships", "legacy", 13, 7, 5],
	"8706": ["Dynamic Leadership", "current", 15, 8, 6],
	"8707": ["Persuasive Influence", "current", 14, 8, 5],
	"8708": ["Effective Coaching", "legacy", 15, 8, 5],
	"8709": ["Team Collaboration", "legacy", 14, 8, 6],
	"8711": ["Engaging Humor", "current", 13, 8, 6],
};

const byCode = new Map(PATHWAYS_CATALOG.map((p) => [p.courseCode, p]));

const electivesAt = (code: string, level: number) =>
	byCode.get(code)?.projects.filter((p) => p.level === level && !p.isRequired)
		.length;

const requiredAt = (code: string, level: number) =>
	byCode.get(code)?.projects.filter((p) => p.level === level && p.isRequired) ??
	[];

describe("PATHWAYS_CATALOG", () => {
	it("covers all 11 paths TI publishes, and nothing else", () => {
		expect([...byCode.keys()].sort()).toEqual(Object.keys(PUBLISHED).sort());
	});

	// There is no 8710. The codes are 8700–8709 plus 8711, confirmed against Base
	// Camp's course-discovery API — so a "fill the gap" edit would be wrong.
	it("does not invent an 8710", () => {
		expect(byCode.has("8710")).toBe(false);
	});

	for (const [code, [name, status, l3, l4, l5]] of Object.entries(PUBLISHED)) {
		describe(`${code} ${name}`, () => {
			it("has the published name and status", () => {
				expect(byCode.get(code)?.name).toBe(name);
				expect(byCode.get(code)?.status).toBe(status);
			});

			it("derives the elective counts toastmasters.org prints", () => {
				expect({
					l3: electivesAt(code, 3),
					l4: electivesAt(code, 4),
					l5: electivesAt(code, 5),
				}).toEqual({ l3, l4, l5 });
			});

			// "These four projects form the base of your Toastmasters journey."
			// Identical on every path, and not five — Base Camp's `total: 5` counts
			// the level's own intro unit, which is not a project (#398).
			//
			// Legacy paths carry TI's superseded edition of each one, which Base Camp
			// names with a " (Legacy)" suffix (#423).
			it("has exactly the 4 shared Level 1 projects", () => {
				const suffix = status === "legacy" ? " (Legacy)" : "";
				expect(requiredAt(code, 1).map((p) => p.name)).toEqual([
					`Ice Breaker${suffix}`,
					`Writing a Speech with Purpose${suffix}`,
					`Introduction to Vocal Variety and Body Language${suffix}`,
					`Evaluation and Feedback${suffix}`,
				]);
			});

			// Uniform: required and elective alike, on every level. Verified against
			// a full 8705 /detail payload, where even the Path Completion project is
			// "Reflect on Your Path (Legacy)".
			it(`${status === "legacy" ? "suffixes" : "does not suffix"} every project name`, () => {
				const names = byCode.get(code)?.projects.map((p) => p.name) ?? [];
				expect(names.length).toBeGreaterThan(0);
				expect(names.every((n) => n.endsWith(" (Legacy)"))).toBe(
					status === "legacy",
				);
			});

			// Level 5 has ONE required project, not two. "Reflect on Your Path" used
			// to be counted here because toastmasters.org draws it inside the
			// Demonstrating Expertise column; Base Camp files it under its own
			// Path Completion chapter, and it is not a level 5 item (#424).
			it("has 3 required at level 2 and 1 each at levels 3, 4 and 5", () => {
				expect(requiredAt(code, 2)).toHaveLength(3);
				expect(requiredAt(code, 3)).toHaveLength(1);
				expect(requiredAt(code, 4)).toHaveLength(1);
				expect(requiredAt(code, 5)).toHaveLength(1);
			});

			it("carries exactly one path-completion project, outside levels 1-5", () => {
				const suffix = status === "legacy" ? " (Legacy)" : "";
				expect(
					requiredAt(code, PATH_COMPLETION_LEVEL).map((p) => p.name),
				).toEqual([`Reflect on Your Path${suffix}`]);
				// It must not also be sitting at level 5.
				expect(
					byCode
						.get(code)
						?.projects.filter((p) => p.name.startsWith("Reflect on Your Path")),
				).toHaveLength(1);
			});

			// pathways_path_levels describes real levels and their elective
			// minimums. Path completion has neither, so it gets no row.
			it("does not add a path-completion row to `levels`", () => {
				expect(byCode.get(code)?.levels.map((l) => l.level)).toEqual([
					1, 2, 3, 4, 5,
				]);
			});

			// A project listed both as required and left in a pool would be seeded
			// twice at the same level, and the picker (#418) would show it twice.
			it("never lists the same project twice at one level", () => {
				const path = byCode.get(code);
				const keys = path?.projects.map((p) => `${p.level}|${p.name}`) ?? [];
				expect(keys).toHaveLength(new Set(keys).size);
			});

			it("requires 2 electives at level 3 and 1 at levels 4 and 5", () => {
				expect(byCode.get(code)?.levels).toEqual([
					{ level: 1, minReqElectives: 0 },
					{ level: 2, minReqElectives: 0 },
					{ level: 3, minReqElectives: 2 },
					{ level: 4, minReqElectives: 1 },
					{ level: 5, minReqElectives: 1 },
				]);
			});
		});
	}
});

// TI is not case-consistent with itself: toastmasters.org capitalises the W in
// both of these, Base Camp does not. Base Camp is authoritative for strings
// because that is what `reconcileCatalog` matches on — the capitalised form
// seeded an orphan row on prod that could never be stamped (#413, #429).
describe("8711 casing follows Base Camp, not the website", () => {
	const humor = PATHWAYS_CATALOG.find((p) => p.courseCode === "8711");
	const names = humor?.projects.map((p) => p.name) ?? [];

	it("uses lowercase 'with Humor'", () => {
		expect(names).toContain("Engage Your Audience with Humor");
		expect(names).toContain("Deliver Your Message with Humor");
	});

	it("carries no capitalised twin", () => {
		expect(names.filter((n) => n.includes("With Humor"))).toEqual([]);
	});
});

describe("levelLabel", () => {
	it("names the sentinel rather than printing 'Level 6'", () => {
		expect(levelLabel(PATH_COMPLETION_LEVEL)).toBe("Path Completion");
		expect(levelLabel(PATH_COMPLETION_LEVEL)).not.toContain("6");
	});

	it("prints ordinary levels unchanged", () => {
		for (const n of [1, 2, 3, 4, 5]) expect(levelLabel(n)).toBe(`Level ${n}`);
	});
});
