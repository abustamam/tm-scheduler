import { describe, expect, it } from "vitest";
import {
	deriveMeetingRoleFlags,
	findGrammarianSlot,
	findTmodSlot,
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

describe("deriveMeetingRoleFlags", () => {
	const slots = [
		{ roleName: "Toastmaster of the Day", assigneeId: "tmod-m" },
		{ roleName: "Grammarian", assigneeId: "gram-m" },
		{ roleName: "Timer", assigneeId: "other-m" },
	];

	it("flags the member holding the TMOD slot", () => {
		expect(deriveMeetingRoleFlags(slots, "tmod-m")).toEqual({
			isTmod: true,
			isGrammarian: false,
		});
	});

	it("flags the member holding the Grammarian slot", () => {
		expect(deriveMeetingRoleFlags(slots, "gram-m")).toEqual({
			isTmod: false,
			isGrammarian: true,
		});
	});

	it("flags neither for an unrelated member", () => {
		expect(deriveMeetingRoleFlags(slots, "other-m")).toEqual({
			isTmod: false,
			isGrammarian: false,
		});
	});

	it("flags neither when identity is null", () => {
		expect(deriveMeetingRoleFlags(slots, null)).toEqual({
			isTmod: false,
			isGrammarian: false,
		});
	});
});

// #464. These two roles carry a CAPABILITY, not a label: the TMOD gets self-serve
// agenda editing (ADR-0010) and the Grammarian owns the Word of the Day (#296).
// Resolving them by display name got all three answers wrong, and the same
// predicates back the SERVER authz, so none of this was only an affordance.
describe("capability roles are identified by key, not by name (#464)", () => {
	it("keeps the capability when the club renames the role", () => {
		// The exact shape #368 promised was safe: rename the label, keep the key.
		const renamed = [
			{ roleName: "MC", roleKey: "toastmaster_of_the_day", assigneeId: "a" },
			{ roleName: "Word Master", roleKey: "grammarian", assigneeId: "b" },
		];
		expect(deriveMeetingRoleFlags(renamed, "a")).toEqual({
			isTmod: true,
			isGrammarian: false,
		});
		expect(deriveMeetingRoleFlags(renamed, "b")).toEqual({
			isTmod: false,
			isGrammarian: true,
		});
	});

	// THE shape production actually produces. `createClubRole`
	// (role-definitions-logic.ts) never writes `key`, so every club-invented role
	// has `key = NULL` and reaches the NAME fallback. Keying off the key alone did
	// not close the escalation for them — narrowing the fallback to exact
	// canonical names is what closes it. Seeding a made-up key here instead (the
	// first version of this test did) passes against a row nothing can create.
	it.each([
		null,
		undefined,
		"club_invented",
	])("denies a look-alike role name with roleKey %p", (roleKey) => {
		for (const roleName of [
			"Toastmaster Evaluator",
			"Toastmaster Assistant",
			"Toastmaster's Helper",
			"Toastmaster Trainee",
		]) {
			expect(
				deriveMeetingRoleFlags([{ roleName, roleKey, assigneeId: "c" }], "c"),
			).toEqual({ isTmod: false, isGrammarian: false });
		}
		for (const roleName of ["Grammarian Assistant", "Grammarian Trainee"]) {
			expect(
				deriveMeetingRoleFlags([{ roleName, roleKey, assigneeId: "c" }], "c"),
			).toEqual({ isTmod: false, isGrammarian: false });
		}
	});

	// The worst real shape: a club that renamed its TMOD before drizzle/0044 (key
	// still NULL, name now "MC") AND invented a look-alike. Neither is keyed, so
	// the key cannot separate them — only the exact-name fallback can, and it must
	// hand the capability to NEITHER rather than to the impostor.
	it("gives a null-key look-alike nothing, even when the real TMOD is also keyless", () => {
		const slots = [
			{ roleName: "MC", roleKey: null, assigneeId: "real" },
			{ roleName: "Toastmaster Assistant", roleKey: null, assigneeId: "alike" },
		];
		expect(deriveMeetingRoleFlags(slots, "alike").isTmod).toBe(false);
		// The renamed one gets nothing either — it carries no key to be found by,
		// which is the #368 backfill gap and not this fix's to close.
		expect(deriveMeetingRoleFlags(slots, "real").isTmod).toBe(false);
	});

	it("prefers the keyed slot over a name-alike, whatever the order", () => {
		// The server reads an unordered SQL result, so a single `find` across both
		// candidates could answer differently between two requests for one meeting.
		const real = {
			roleName: "MC",
			roleKey: "toastmaster_of_the_day",
			assigneeId: "real",
		};
		const alike = {
			roleName: "Toastmaster Assistant",
			roleKey: null,
			assigneeId: "alike",
		};
		for (const slots of [
			[real, alike],
			[alike, real],
		]) {
			expect(findTmodSlot(slots)?.assigneeId).toBe("real");
			expect(deriveMeetingRoleFlags(slots, "real").isTmod).toBe(true);
			expect(deriveMeetingRoleFlags(slots, "alike").isTmod).toBe(false);
		}
	});

	it("prefers the keyed Grammarian slot over a name-alike too", () => {
		const real = {
			roleName: "Word Master",
			roleKey: "grammarian",
			assigneeId: "real",
		};
		const alike = {
			roleName: "Grammarian",
			roleKey: null,
			assigneeId: "alike",
		};
		for (const slots of [
			[real, alike],
			[alike, real],
		]) {
			expect(findGrammarianSlot(slots)?.assigneeId).toBe("real");
			expect(deriveMeetingRoleFlags(slots, "real").isGrammarian).toBe(true);
			expect(deriveMeetingRoleFlags(slots, "alike").isGrammarian).toBe(false);
		}
	});

	it("still matches by name for a slot with no key", () => {
		// `drizzle/0044` backfilled keys by exact canonical NAME, so a club that
		// renamed before it ran still has NULL there. Those clubs keep working the
		// way they always did rather than losing the capability to this fix.
		const preBackfill = [
			{ roleName: "Toastmaster of the Day", roleKey: null, assigneeId: "a" },
			{ roleName: "Grammarian", assigneeId: "b" },
		];
		expect(deriveMeetingRoleFlags(preBackfill, "a").isTmod).toBe(true);
		expect(deriveMeetingRoleFlags(preBackfill, "b").isGrammarian).toBe(true);
	});

	it("exposes the same answer through the slot finders", () => {
		const slots = [
			{ roleName: "MC", roleKey: "toastmaster_of_the_day", assigneeId: "a" },
			{ roleName: "Word Master", roleKey: "grammarian", assigneeId: "b" },
			{ roleName: "Timer", roleKey: "timer", assigneeId: "c" },
		];
		expect(findTmodSlot(slots)?.assigneeId).toBe("a");
		expect(findGrammarianSlot(slots)?.assigneeId).toBe("b");
		expect(findTmodSlot([slots[2]])).toBeUndefined();
	});
});
