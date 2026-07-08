import { describe, expect, it } from "vitest";
import {
	type AgendaRecord,
	levenshtein,
	mapRoleLabel,
	matchMember,
	missingRoleDefinitions,
	normalizeName,
	planMeetingImport,
	type RoleDef,
	type RosterMember,
} from "./import-agendas-logic";

const roster: RosterMember[] = [
	{ memberId: "m1", personId: "p1", name: "Jagpal Singh" },
	{ memberId: "m2", personId: "p2", name: "Saiful Haque" },
	{ memberId: "m3", personId: "p3", name: "Mahbuba Khan" },
	{ memberId: "m4", personId: "p4", name: "Schinthia Islam" },
];

describe("levenshtein", () => {
	it("computes classic edit distances", () => {
		expect(levenshtein("kitten", "sitting")).toBe(3);
		expect(levenshtein("flaw", "lawn")).toBe(2);
		expect(levenshtein("book", "book")).toBe(0);
	});

	it("handles empty-string cases as the other string's length", () => {
		expect(levenshtein("", "")).toBe(0);
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
	});
});

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

	it("does NOT auto-match when two roster members share the same normalized name", () => {
		const dupes: RosterMember[] = [
			{ memberId: "d1", personId: "pd1", name: "John Smith" },
			{ memberId: "d2", personId: "pd2", name: "john  smith" },
		];
		const r = matchMember("John Smith", dupes, {});
		expect(r.member).toBeUndefined();
		expect(r.suggestions).toEqual(["John Smith", "john  smith"]);
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

const roleDefs: RoleDef[] = [
	{ id: "rd-tm", name: "Toastmaster of the Day" },
	{ id: "rd-sp", name: "Speaker" },
	{ id: "rd-ev", name: "Evaluator" },
	{ id: "rd-vc", name: "Vote Counter" },
];

const baseRecord: AgendaRecord = {
	meetingNumber: 55,
	date: "2026-07-09",
	theme: "Unity",
	wordOfTheDay: "Momentum",
	sourceFileId: "f1",
	sourceTitle: "55th",
	roles: [
		{ label: "Toastmaster", name: "Schinthia Islam" },
		{
			label: "Speaker #1",
			name: "Jagpal Singh",
			speech: { title: "Leadership in the Era of AI", projectLevel: "Level 2", projectName: "Effective Body Language" },
		},
		{ label: "Evaluator #1", name: "Saiful Haque", evaluates: "Speaker #1" },
		{ label: "Vote Counter", name: "Mahbuba Khan" },
	],
};

describe("planMeetingImport", () => {
	it("plans a meeting, matched slots, a speech, and links the evaluator to its speaker slot", () => {
		const plan = planMeetingImport(baseRecord, roster, roleDefs, {});

		expect(plan.meeting).toMatchObject({
			date: "2026-07-09",
			theme: "Unity",
			wordOfTheDay: "Momentum",
			lengthMinutes: 60,
			status: "completed",
		});

		const tmSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-tm");
		expect(tmSlot).toMatchObject({ assignedMemberId: "m4", slotIndex: 0, status: "confirmed" });

		const spSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-sp" && s.slotIndex === 0);
		expect(spSlot?.assignedMemberId).toBe("m1");
		expect(spSlot?.speech).toMatchObject({
			personId: "p1",
			title: "Leadership in the Era of AI",
			projectLevel: "Level 2",
			projectName: "Effective Body Language",
		});

		const evSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-ev" && s.slotIndex === 0);
		expect(evSlot?.evaluatesTarget).toEqual({ roleName: "Speaker", slotIndex: 0 });

		expect(plan.slots.some((s) => s.roleDefinitionId === "rd-vc")).toBe(true);
		expect(plan.unmatched).toHaveLength(0);
	});

	it("reports (and skips) a row whose name has no confident match", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Timer", name: "Totally Unknown" }] };
		const plan = planMeetingImport(rec, roster, [...roleDefs, { id: "rd-ti", name: "Timer" }], {});
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toEqual([
			expect.objectContaining({ kind: "name", label: "Timer", name: "Totally Unknown" }),
		]);
	});

	it("reports an unknown role label with reason 'unknown-label'", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Something Else", name: "Schinthia Islam" }] };
		const plan = planMeetingImport(rec, roster, roleDefs, {});
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toEqual([
			expect.objectContaining({ kind: "role", label: "Something Else", reason: "unknown-label" }),
		]);
	});

	it("reports (and skips) a row whose role label maps to a definition the club lacks", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Timer", name: "Schinthia Islam" }] };
		const plan = planMeetingImport(rec, roster, roleDefs, {}); // no Timer def
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toEqual([
			expect.objectContaining({ kind: "role", label: "Timer", reason: "missing-definition" }),
		]);
	});

	it("keeps the evaluator slot but reports a malformed 'evaluates' label with reason 'unknown-evaluates-label'", () => {
		const rec: AgendaRecord = {
			...baseRecord,
			roles: [{ label: "Evaluator #1", name: "Saiful Haque", evaluates: "Spekaer #1" }],
		};
		const plan = planMeetingImport(rec, roster, roleDefs, {});
		const evSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-ev" && s.slotIndex === 0);
		expect(evSlot?.assignedMemberId).toBe("m2");
		expect(evSlot?.evaluatesTarget).toBeUndefined();
		expect(plan.unmatched).toEqual([
			expect.objectContaining({ kind: "role", label: "Spekaer #1", reason: "unknown-evaluates-label" }),
		]);
	});

	it("skips out-of-scope labels (Sergeant at Arms), even with odd spacing, without reporting them", () => {
		const rec: AgendaRecord = {
			...baseRecord,
			roles: [{ label: "Sergeant  at  Arms", name: "Muhammad Ali" }],
		};
		const plan = planMeetingImport(rec, roster, roleDefs, {});
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toHaveLength(0);
	});

	it("creates a speaker slot with no speech when the row has no speech detail", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Speaker #2", name: "Saiful Haque" }] };
		const plan = planMeetingImport(rec, roster, roleDefs, {});
		const s = plan.slots.find((x) => x.roleDefinitionId === "rd-sp" && x.slotIndex === 1);
		expect(s?.assignedMemberId).toBe("m2");
		expect(s?.speech).toBeUndefined();
	});
});

describe("missingRoleDefinitions", () => {
	it("returns a Vote Counter definition to create when the club lacks it", () => {
		const missing = missingRoleDefinitions([{ id: "rd-tm", name: "Toastmaster of the Day" }]);
		expect(missing).toEqual([{ name: "Vote Counter", category: "functionary", isSpeakerRole: false, defaultCount: 1 }]);
	});

	it("returns nothing when Vote Counter already exists", () => {
		expect(missingRoleDefinitions([{ id: "rd-vc", name: "Vote Counter" }])).toEqual([]);
	});
});
