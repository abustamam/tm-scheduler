import { describe, expect, it } from "vitest";
import { mapRoleLabel, matchMember, normalizeName, type RosterMember } from "./import-agendas-logic";

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

describe("mapRoleLabel", () => {
	it("maps fixed labels to role-definition names at slotIndex 0", () => {
		expect(mapRoleLabel("Toastmaster")).toEqual({ roleName: "Toastmaster of the Day", slotIndex: 0 });
		expect(mapRoleLabel("TableTopic Master")).toEqual({ roleName: "Table Topics Master", slotIndex: 0 });
		expect(mapRoleLabel("Grammarian/WOD")).toEqual({ roleName: "Grammarian", slotIndex: 0 });
		expect(mapRoleLabel("Ah Counter")).toEqual({ roleName: "Ah-Counter", slotIndex: 0 });
		expect(mapRoleLabel("General Evaluator")).toEqual({ roleName: "General Evaluator", slotIndex: 0 });
		expect(mapRoleLabel("Timer")).toEqual({ roleName: "Timer", slotIndex: 0 });
	});

	it("maps numbered Speaker/Evaluator labels to slotIndex N-1", () => {
		expect(mapRoleLabel("Speaker #1")).toEqual({ roleName: "Speaker", slotIndex: 0 });
		expect(mapRoleLabel("Speaker #3")).toEqual({ roleName: "Speaker", slotIndex: 2 });
		expect(mapRoleLabel("Evaluator #2")).toEqual({ roleName: "Evaluator", slotIndex: 1 });
	});

	it("maps Vote Counter (and the 'Voter Counter' typo) to Vote Counter", () => {
		expect(mapRoleLabel("Vote Counter")).toEqual({ roleName: "Vote Counter", slotIndex: 0 });
		expect(mapRoleLabel("Voter Counter")).toEqual({ roleName: "Vote Counter", slotIndex: 0 });
	});

	it("returns null for out-of-scope / unknown labels", () => {
		expect(mapRoleLabel("Sergeant at Arms")).toBeNull();
		expect(mapRoleLabel("Something Else")).toBeNull();
	});
});
