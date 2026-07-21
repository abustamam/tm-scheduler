import { describe, expect, it } from "vitest";
import {
	computeDcpSummary,
	DCP_GOALS,
	EDUCATION_GOAL_KEYS,
	educationGoalsFromLevelCounts,
	isBaseMet,
	isGoalMet,
	netGrowth,
	programYearForDate,
	programYearLabel,
	programYearWindow,
	splitNewMembers,
	splitPaired,
	tierLabel,
} from "./dcp";

describe("DCP goal catalog", () => {
	it("has exactly the 10 standardized DCP goals", () => {
		expect(DCP_GOALS).toHaveLength(10);
		expect(DCP_GOALS.map((g) => g.key)).toEqual([
			"g1",
			"g2",
			"g3",
			"g4",
			"g5",
			"g6",
			"g7",
			"g8",
			"g9",
			"g10",
		]);
	});

	it("carries the correct targets (4/2/2/2/1/1, 4/4, 1, 1)", () => {
		expect(DCP_GOALS.map((g) => g.target)).toEqual([
			4, 2, 2, 2, 1, 1, 4, 4, 1, 1,
		]);
	});

	it("categorizes goals: education 1-6, membership 7-8, training 9, administration 10", () => {
		const byCat = DCP_GOALS.map((g) => g.category);
		expect(byCat).toEqual([
			"education",
			"education",
			"education",
			"education",
			"education",
			"education",
			"membership",
			"membership",
			"training",
			"administration",
		]);
	});

	it("marks only goals 9 and 10 as composite (single met toggle)", () => {
		const composites = DCP_GOALS.filter((g) => g.composite).map((g) => g.key);
		expect(composites).toEqual(["g9", "g10"]);
	});
});

describe("program year", () => {
	it("maps July onward to the calendar year it starts", () => {
		// 0-indexed month: 6 = July
		expect(programYearForDate(new Date(2026, 6, 1))).toBe(2026);
		expect(programYearForDate(new Date(2026, 11, 31))).toBe(2026);
	});

	it("maps Jan–June back to the prior calendar year", () => {
		expect(programYearForDate(new Date(2026, 0, 1))).toBe(2025);
		expect(programYearForDate(new Date(2026, 5, 30))).toBe(2025);
	});

	it("window runs Jul 1 of the year to Jul 1 of the next year (exclusive end)", () => {
		const { start, end } = programYearWindow(2026);
		expect(start).toEqual(new Date(2026, 6, 1));
		expect(end).toEqual(new Date(2027, 6, 1));
	});

	it("labels the year span, e.g. 2026 -> 2026–27", () => {
		expect(programYearLabel(2026)).toBe("2026–27");
		expect(programYearLabel(2029)).toBe("2029–30");
	});
});

describe("membership base requirement", () => {
	it("is met with 20 or more active members regardless of baseline", () => {
		expect(isBaseMet(20, null)).toBe(true);
		expect(isBaseMet(25, 40)).toBe(true);
	});

	it("is met under 20 only with net growth of +5 vs the baseline", () => {
		expect(isBaseMet(15, 10)).toBe(true); // +5
		expect(isBaseMet(14, 10)).toBe(false); // +4
		expect(isBaseMet(15, null)).toBe(false); // no baseline, under 20
	});

	it("reports net growth vs the baseline (null when no baseline)", () => {
		expect(netGrowth(18, 12)).toBe(6);
		expect(netGrowth(18, null)).toBeNull();
	});
});

describe("new-member assist split (goals 7 & 8)", () => {
	it("fills goal 7 first, then goal 8, capping each at 4", () => {
		expect(splitNewMembers(0)).toEqual({ g7: 0, g8: 0 });
		expect(splitNewMembers(3)).toEqual({ g7: 3, g8: 0 });
		expect(splitNewMembers(4)).toEqual({ g7: 4, g8: 0 });
		expect(splitNewMembers(6)).toEqual({ g7: 4, g8: 2 });
		expect(splitNewMembers(9)).toEqual({ g7: 4, g8: 4 }); // extra beyond 8 ignored
	});
});

describe("paired-goal split (generalizes the 7/8 assist)", () => {
	it("fills the first goal to the cap before the second (cap 2 — goals 2/3)", () => {
		expect(splitPaired(0, 2)).toEqual({ first: 0, second: 0 });
		expect(splitPaired(1, 2)).toEqual({ first: 1, second: 0 });
		expect(splitPaired(2, 2)).toEqual({ first: 2, second: 0 });
		expect(splitPaired(3, 2)).toEqual({ first: 2, second: 1 });
		expect(splitPaired(4, 2)).toEqual({ first: 2, second: 2 });
	});

	it("handles the cap-1 pair (goals 5/6)", () => {
		expect(splitPaired(0, 1)).toEqual({ first: 0, second: 0 });
		expect(splitPaired(1, 1)).toEqual({ first: 1, second: 0 });
		expect(splitPaired(2, 1)).toEqual({ first: 1, second: 1 });
	});

	it("drops overflow beyond both caps — both goals are already met", () => {
		expect(splitPaired(9, 2)).toEqual({ first: 2, second: 2 });
		expect(splitPaired(7, 1)).toEqual({ first: 1, second: 1 });
	});

	it("never returns negatives for a zero or empty count", () => {
		expect(splitPaired(0, 4)).toEqual({ first: 0, second: 0 });
	});

	it("agrees with splitNewMembers, which is the cap-4 case", () => {
		for (const n of [0, 1, 4, 5, 8, 12]) {
			const { first, second } = splitPaired(n, 4);
			expect(splitNewMembers(n)).toEqual({ g7: first, g8: second });
		}
	});
});

describe("education assist derivation (goals 1–6)", () => {
	const none = { n1: 0, n2: 0, n3: 0, n45: 0 };

	it("derives nothing from an empty count set", () => {
		expect(educationGoalsFromLevelCounts(none)).toEqual({
			g1: 0,
			g2: 0,
			g3: 0,
			g4: 0,
			g5: 0,
			g6: 0,
		});
	});

	it("maps the mixed seed from the spec (n1=6, n2=3, n45=2)", () => {
		expect(
			educationGoalsFromLevelCounts({ n1: 6, n2: 3, n3: 2, n45: 2 }),
		).toEqual({ g1: 6, g2: 2, g3: 1, g4: 2, g5: 1, g6: 1 });
	});

	it("leaves the unpaired goals 1 and 4 uncapped past their targets", () => {
		const d = educationGoalsFromLevelCounts({ ...none, n1: 9, n3: 7 });
		expect(d.g1).toBe(9); // target is 4
		expect(d.g4).toBe(7); // target is 2
	});

	it("splits level 2 across the 2/3 pair and drops overflow past 4", () => {
		expect(educationGoalsFromLevelCounts({ ...none, n2: 1 })).toMatchObject({
			g2: 1,
			g3: 0,
		});
		expect(educationGoalsFromLevelCounts({ ...none, n2: 3 })).toMatchObject({
			g2: 2,
			g3: 1,
		});
		expect(educationGoalsFromLevelCounts({ ...none, n2: 11 })).toMatchObject({
			g2: 2,
			g3: 2,
		});
	});

	it("splits level 4+5 across the 5/6 pair at cap 1 each", () => {
		expect(educationGoalsFromLevelCounts({ ...none, n45: 1 })).toMatchObject({
			g5: 1,
			g6: 0,
		});
		expect(educationGoalsFromLevelCounts({ ...none, n45: 5 })).toMatchObject({
			g5: 1,
			g6: 1,
		});
	});

	it("fills exactly the six education goals — never g7–g10", () => {
		const keys = Object.keys(
			educationGoalsFromLevelCounts({ n1: 4, n2: 4, n3: 4, n45: 4 }),
		);
		expect(keys.sort()).toEqual([...EDUCATION_GOAL_KEYS].sort());
	});
});

describe("goal met", () => {
	it("is met when achieved reaches the target", () => {
		const g1 = DCP_GOALS[0];
		expect(isGoalMet(g1, 3)).toBe(false);
		expect(isGoalMet(g1, 4)).toBe(true);
		expect(isGoalMet(g1, 5)).toBe(true);
	});
});

describe("recognition tier", () => {
	const base = { currentActive: 20, baseMemberCount: null };

	function progressWith(metCount: number): Record<string, number> {
		// Mark the first `metCount` goals met at their target.
		const p: Record<string, number> = {};
		DCP_GOALS.forEach((g, i) => {
			p[g.key] = i < metCount ? g.target : 0;
		});
		return p;
	}

	it("no tier below 5 goals even with the base met", () => {
		const s = computeDcpSummary({ progress: progressWith(4), ...base });
		expect(s.goalsMet).toBe(4);
		expect(s.tier).toBeNull();
		expect(s.baseMet).toBe(true);
		expect(s.goalsToDistinguished).toBe(1);
	});

	it("Distinguished at 5, Select at 7, President's at 9 — base met", () => {
		expect(computeDcpSummary({ progress: progressWith(5), ...base }).tier).toBe(
			"distinguished",
		);
		expect(computeDcpSummary({ progress: progressWith(7), ...base }).tier).toBe(
			"select",
		);
		expect(computeDcpSummary({ progress: progressWith(9), ...base }).tier).toBe(
			"presidents",
		);
	});

	it("no tier when the base requirement is unmet, however many goals are met", () => {
		const s = computeDcpSummary({
			progress: progressWith(10),
			currentActive: 12,
			baseMemberCount: null,
		});
		expect(s.goalsMet).toBe(10);
		expect(s.baseMet).toBe(false);
		expect(s.tier).toBeNull();
	});

	it("labels the tiers for display", () => {
		expect(tierLabel("distinguished")).toBe("Distinguished");
		expect(tierLabel("select")).toBe("Select Distinguished");
		expect(tierLabel("presidents")).toBe("President's Distinguished");
	});
});
