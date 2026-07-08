import { describe, expect, it } from "vitest";
import { matchMember, normalizeName, type RosterMember } from "./import-agendas-logic";

const roster: RosterMember[] = [
	{ memberId: "m1", personId: "p1", name: "Jagpal Singh" },
	{ memberId: "m2", personId: "p2", name: "Saiful Haque" },
	{ memberId: "m3", personId: "p3", name: "Mahbuba Khan" },
	{ memberId: "m4", personId: "p4", name: "Schinthia Islam" },
];

describe("normalizeName", () => {
	it("lowercases, trims, collapses whitespace, strips the (G) guest marker", () => {
		expect(normalizeName("  Hana   Haque (G) ")).toBe("hana haque");
		expect(normalizeName("Jagpal Singh")).toBe("jagpal singh");
	});
});

describe("matchMember", () => {
	it("matches on exact normalized name", () => {
		const r = matchMember("schinthia islam", roster, {});
		expect(r.member?.memberId).toBe("m4");
	});

	it("applies the alias map before matching", () => {
		const r = matchMember("Dina", roster, { dina: "Mahbuba Khan" });
		expect(r.member?.memberId).toBe("m3");
	});

	it("auto-corrects a unique typo at edit-distance 1", () => {
		const r = matchMember("Jaqpal Singh", roster, {});
		expect(r.member?.memberId).toBe("m1");
	});

	it("does NOT auto-match when two candidates tie at distance 1", () => {
		const two: RosterMember[] = [
			{ memberId: "a", personId: "pa", name: "Sara" },
			{ memberId: "b", personId: "pb", name: "Kara" },
		];
		const r = matchMember("Tara", two, {});
		expect(r.member).toBeUndefined();
		expect(r.suggestions.sort()).toEqual(["Kara", "Sara"]);
	});

	it("reports near-misses (distance 2) as suggestions but does not match", () => {
		const r = matchMember("Jagxxl Singh", roster, {});
		expect(r.member).toBeUndefined();
		expect(r.suggestions).toContain("Jagpal Singh");
	});

	it("strips (G) and matches a former guest who is now on the roster", () => {
		const r = matchMember("Schinthia Islam (G)", roster, {});
		expect(r.member?.memberId).toBe("m4");
	});
});
