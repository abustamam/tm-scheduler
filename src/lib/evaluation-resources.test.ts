import { describe, expect, it } from "vitest";
import {
	EVALUATION_RESOURCES,
	filterEvaluationResources,
	GENERIC_EVALUATION_RESOURCE,
	resolveEvaluationResources,
	resourcesForProject,
} from "#/lib/evaluation-resources";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";

/** Distinct project names across all 11 paths, "(Legacy)" stripped. */
const catalogProjects = (): string[] => {
	const s = new Set<string>();
	for (const path of PATHWAYS_CATALOG)
		for (const p of path.projects)
			s.add(p.name.replace(/\s*\(Legacy\)\s*$/, ""));
	return [...s];
};

describe("evaluation resource mapping", () => {
	// The assertion that catches TI's four title/description conflicts. Naive
	// title matching resolves 59/60; naive description matching 57/60. Only the
	// hand-audited table reaches 60/60, so this fails the moment someone
	// "simplifies" the table into a derivation.
	it("covers every catalog project", () => {
		const missing = catalogProjects().filter(
			(name) => resourcesForProject(name).length === 0,
		);
		expect(missing).toEqual([]);
	});

	it("covers exactly 60 distinct projects", () => {
		expect(new Set(catalogProjects()).size).toBe(60);
	});

	it.each([
		["8103E", "Writing a Speech with Purpose"],
		["8409E", "Managing a Difficult Audience"],
		["8410E", undefined],
		["8207E", "Understanding Your Leadership Style"],
	])("resolves TI conflict %s to the audited project", (code, expected) => {
		const found = EVALUATION_RESOURCES.find((r) => r.itemCode === code);
		expect(found?.project).toBe(expected);
	});

	it("resolves a (Legacy) name to the current-edition resource", () => {
		const current = resourcesForProject("Active Listening");
		const legacy = resourcesForProject("Active Listening (Legacy)");
		expect(legacy).toEqual(current);
		expect(legacy.length).toBeGreaterThan(0);
	});

	it("is insensitive to case and punctuation drift from Base Camp", () => {
		expect(resourcesForProject("  question and answer session  ")).toEqual(
			resourcesForProject("Question-and-Answer Session"),
		);
	});

	it("returns [] for an unknown project, never the generic", () => {
		// Base Camp can name a project the catalog does not have (see #606).
		// The caller decides whether to fall back; the lookup must not decide.
		expect(resourcesForProject("Advanced Mentoring")).toEqual([]);
		expect(resourcesForProject(null)).toEqual([]);
		expect(resourcesForProject(undefined)).toEqual([]);
		expect(resourcesForProject("")).toEqual([]);
	});

	it("returns all three Evaluation and Feedback parts", () => {
		const rs = resourcesForProject("Evaluation and Feedback");
		expect(rs).toHaveLength(3);
		expect(rs.map((r) => r.part).sort()).toEqual([
			"Evaluator role",
			"First speech",
			"Second speech",
		]);
	});

	it("returns both Vocal Variety parts", () => {
		const rs = resourcesForProject(
			"Introduction to Vocal Variety and Body Language",
		);
		expect(rs).toHaveLength(2);
		expect(rs.map((r) => r.part).sort()).toEqual([
			"Evaluation resource",
			"Speech profile",
		]);
	});
});

describe("resolveEvaluationResources", () => {
	it("flags nothing special for a current-edition project", () => {
		const r = resolveEvaluationResources("Active Listening");
		expect(r.currentEditionNote).toBe(false);
		expect(r.isGenericFallback).toBe(false);
		expect(r.resources.length).toBeGreaterThan(0);
	});

	it("flags the current-edition note for a (Legacy) project", () => {
		const r = resolveEvaluationResources("Active Listening (Legacy)");
		expect(r.currentEditionNote).toBe(true);
		expect(r.isGenericFallback).toBe(false);
		expect(r.resources).toEqual(resourcesForProject("Active Listening"));
	});

	it("falls back to the generic resource for an unknown or absent project", () => {
		for (const input of [null, undefined, "", "Advanced Mentoring"]) {
			const r = resolveEvaluationResources(input);
			expect(r.isGenericFallback).toBe(true);
			expect(r.resources).toEqual([GENERIC_EVALUATION_RESOURCE]);
			expect(r.currentEditionNote).toBe(false);
		}
	});
});

describe("filterEvaluationResources", () => {
	it("returns everything for an empty query", () => {
		expect(filterEvaluationResources("")).toHaveLength(64);
		expect(filterEvaluationResources("   ")).toHaveLength(64);
	});

	it("matches on project name, case-insensitively", () => {
		const r = filterEvaluationResources("active listening");
		expect(r).toHaveLength(1);
		expect(r[0].project).toBe("Active Listening");
	});

	it("matches on TI item code, either case", () => {
		expect(filterEvaluationResources("8200E")[0]?.itemCode).toBe("8200E");
		expect(filterEvaluationResources("8200e")).toHaveLength(1);
	});

	it("ignores punctuation differences", () => {
		// A member types what they remember, not TI's hyphenation.
		expect(
			filterEvaluationResources("question and answer").length,
		).toBeGreaterThan(0);
	});

	it("returns nothing for a query that matches nothing", () => {
		expect(filterEvaluationResources("zzzzz")).toEqual([]);
	});

	it("finds the generic resource by name", () => {
		expect(
			filterEvaluationResources("generic").some((x) => x.itemCode === "8053"),
		).toBe(true);
	});

	it("finds a part by name", () => {
		const r = filterEvaluationResources("evaluator role");
		expect(r).toHaveLength(1);
		expect(r[0].part).toBe("Evaluator role");
	});
});

// Absolute, not relative. CLAUDE.md: a test stated relative to the constant it
// guards cannot fail — `toBeGreaterThan(0)` passes for a truncated table too.
describe("structural integrity", () => {
	it("has exactly 64 entries", () => {
		expect(EVALUATION_RESOURCES).toHaveLength(64);
	});

	it("has unique non-empty keys", () => {
		const keys = EVALUATION_RESOURCES.map((r) => r.key);
		expect(keys.every((k) => k.length > 0)).toBe(true);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("has unique item codes where present, and exactly two absent", () => {
		const codes = EVALUATION_RESOURCES.map((r) => r.itemCode);
		const present = codes.filter((c): c is string => c !== null);
		expect(codes.length - present.length).toBe(2);
		expect(new Set(present).size).toBe(present.length);
	});

	it("only ever links to Toastmasters over https", () => {
		for (const r of EVALUATION_RESOURCES) {
			const u = new URL(r.url);
			expect(u.protocol).toBe("https:");
			expect(
				u.hostname === "toastmasters.org" ||
					u.hostname.endsWith(".toastmasters.org"),
			).toBe(true);
		}
	});

	it("never points two entries at the same PDF", () => {
		// The shape a copy-paste slip in a hand-audited 64-row table would take.
		const urls = EVALUATION_RESOURCES.map((r) => r.url);
		expect(new Set(urls).size).toBe(urls.length);
	});

	it("has exactly one generic entry, and it is 8053", () => {
		const generic = EVALUATION_RESOURCES.filter((r) => r.project === null);
		expect(generic).toHaveLength(1);
		expect(generic[0].itemCode).toBe("8053");
		expect(generic[0]).toBe(GENERIC_EVALUATION_RESOURCE);
	});

	it("gives every multi-resource project distinct parts", () => {
		const byProject = new Map<string, string[]>();
		for (const r of EVALUATION_RESOURCES) {
			if (!r.project) continue;
			byProject.set(r.project, [
				...(byProject.get(r.project) ?? []),
				r.part ?? "",
			]);
		}
		for (const [project, parts] of byProject) {
			if (parts.length === 1) {
				expect(parts[0], `${project} should have no part`).toBe("");
				continue;
			}
			expect(new Set(parts).size, `${project} parts must differ`).toBe(
				parts.length,
			);
			expect(
				parts.every((p) => p !== ""),
				`${project} parts must be named`,
			).toBe(true);
		}
	});
});
