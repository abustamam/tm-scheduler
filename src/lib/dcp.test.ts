import { describe, expect, it } from "vitest";
import {
	computeDcpSummary,
	DCP_GOALS,
	isBaseMet,
	isGoalMet,
	netGrowth,
	programYearForDate,
	programYearLabel,
	programYearWindow,
	splitNewMembers,
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
