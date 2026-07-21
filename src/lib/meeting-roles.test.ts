import { describe, expect, it } from "vitest";
import {
	isGrammarianRoleName,
	isTmodRoleName,
	pairedRoleIds,
	pickSpeakerAndEvaluatorRoles,
	type RoleDefLite,
} from "./meeting-roles";

describe("isTmodRoleName", () => {
	it("matches the standard TMOD role names (case/space-insensitive)", () => {
		expect(isTmodRoleName("Toastmaster of the Day")).toBe(true);
		expect(isTmodRoleName("Toastmaster")).toBe(true);
		expect(isTmodRoleName("  toastmaster of the day  ")).toBe(true);
	});

	it("does not match other roles that merely contain 'master'", () => {
		expect(isTmodRoleName("Table Topics Master")).toBe(false);
		expect(isTmodRoleName("Toastmasters")).toBe(false); // plural, no boundary
		expect(isTmodRoleName("General Evaluator")).toBe(false);
		expect(isTmodRoleName("Timer")).toBe(false);
	});
});

describe("isGrammarianRoleName", () => {
	it("matches the standard Grammarian role name (case/space-insensitive)", () => {
		expect(isGrammarianRoleName("Grammarian")).toBe(true);
		expect(isGrammarianRoleName("  grammarian  ")).toBe(true);
	});

	it("does not match other roles", () => {
		expect(isGrammarianRoleName("Grammarians")).toBe(false); // plural, no boundary
		expect(isGrammarianRoleName("Grammar")).toBe(false);
		expect(isGrammarianRoleName("Ah-Counter")).toBe(false);
		expect(isGrammarianRoleName("Toastmaster of the Day")).toBe(false);
	});
});

const def = (over: Partial<RoleDefLite>): RoleDefLite => ({
	id: "x",
	category: "functionary",
	defaultCount: 1,
	sortOrder: 0,
	isSpeakerRole: false,
	...over,
});

describe("pickSpeakerAndEvaluatorRoles", () => {
	it("picks the speaker role and the highest-count evaluator (not General Evaluator)", () => {
		const defs = [
			def({
				id: "spk",
				category: "speaker",
				isSpeakerRole: true,
				defaultCount: 3,
				sortOrder: 2,
			}),
			def({ id: "ev", category: "evaluator", defaultCount: 3, sortOrder: 3 }),
			def({ id: "gen", category: "evaluator", defaultCount: 1, sortOrder: 4 }),
		];
		expect(pickSpeakerAndEvaluatorRoles(defs)).toEqual({
			speakerRoleId: "spk",
			evaluatorRoleId: "ev",
		});
	});

	it("returns null evaluator when the club has no evaluator role", () => {
		const defs = [def({ id: "spk", isSpeakerRole: true, category: "speaker" })];
		expect(pickSpeakerAndEvaluatorRoles(defs)).toEqual({
			speakerRoleId: "spk",
			evaluatorRoleId: null,
		});
	});

	it("breaks evaluator ties by lowest sortOrder", () => {
		const defs = [
			def({ id: "spk", isSpeakerRole: true, category: "speaker" }),
			def({ id: "a", category: "evaluator", defaultCount: 2, sortOrder: 5 }),
			def({ id: "b", category: "evaluator", defaultCount: 2, sortOrder: 1 }),
		];
		expect(pickSpeakerAndEvaluatorRoles(defs).evaluatorRoleId).toBe("b");
	});

	it("picks the lowest-sortOrder speaker role when several exist", () => {
		const defs = [
			def({ id: "s2", isSpeakerRole: true, category: "speaker", sortOrder: 9 }),
			def({ id: "s1", isSpeakerRole: true, category: "speaker", sortOrder: 2 }),
		];
		expect(pickSpeakerAndEvaluatorRoles(defs).speakerRoleId).toBe("s1");
	});

	it("throws when there is no speaker role", () => {
		expect(() =>
			pickSpeakerAndEvaluatorRoles([def({ category: "evaluator" })]),
		).toThrow();
	});
});

describe("pairedRoleIds", () => {
	it("returns the speaker + highest-count evaluator ids", () => {
		const ids = pairedRoleIds([
			def({
				id: "spk",
				category: "speaker",
				isSpeakerRole: true,
				sortOrder: 1,
			}),
			def({ id: "ev", category: "evaluator", defaultCount: 3, sortOrder: 2 }),
			def({
				id: "gen-ev",
				category: "evaluator",
				defaultCount: 1,
				sortOrder: 3,
			}),
			def({ id: "timer", sortOrder: 4 }),
		]);
		expect(ids).toEqual(new Set(["spk", "ev"]));
	});

	it("is empty when the club has no speaker role", () => {
		expect(pairedRoleIds([def({ id: "timer" })])).toEqual(new Set());
	});

	it("returns just the speaker when there is no evaluator role", () => {
		expect(
			pairedRoleIds([
				def({ id: "spk", category: "speaker", isSpeakerRole: true }),
			]),
		).toEqual(new Set(["spk"]));
	});
});
