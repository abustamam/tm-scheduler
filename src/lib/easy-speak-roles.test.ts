import { describe, expect, it } from "vitest";
import {
	EASY_SPEAK_ROLE_MAP,
	normalizeEasySpeakRoleName,
	ownRoleDisplayName,
	standardRoleKeyFor,
} from "./easy-speak-roles";
import { ROLE_TEMPLATE } from "./role-template";

describe("Easy-Speak role labels (#1051)", () => {
	it.each([
		["1st Speaker", "speaker"],
		["2nd Evaluator", "evaluator"],
		["Timer 2 - Online", "timer"],
		["Toastmaster", "toastmaster_of_the_day"],
		["Table Topic Master", "table_topics_master"],
		["Ah Master", "ah_counter"],
		["Ah-Counter", "ah_counter"],
		["General Evaluator", "general_evaluator"],
		["Vote Counter", "vote_counter"],
		["Grammarian", "grammarian"],
	])("%s lands on the standard role %s", (label, key) => {
		expect(standardRoleKeyFor(label)).toBe(key);
	});

	it("leaves a club's own role without a standard key", () => {
		expect(standardRoleKeyFor("Joke Master")).toBeNull();
		expect(standardRoleKeyFor("Listener")).toBeNull();
	});

	it("only maps to keys the role template has", () => {
		const keys = new Set(ROLE_TEMPLATE.map((r) => r.key));
		for (const key of Object.values(EASY_SPEAK_ROLE_MAP)) {
			expect(keys.has(key), key).toBe(true);
		}
	});

	it("strips ordinals, trailing numbers and the Online suffix, once", () => {
		expect(normalizeEasySpeakRoleName("  3rd   Evaluator ")).toBe("evaluator");
		expect(normalizeEasySpeakRoleName("Timer 2 - Online")).toBe("timer");
	});

	it("keeps the printed casing for a club-own role's name", () => {
		expect(ownRoleDisplayName("Joke Master")).toBe("Joke Master");
		expect(ownRoleDisplayName("2nd Joke Master - Online")).toBe("Joke Master");
	});
});
