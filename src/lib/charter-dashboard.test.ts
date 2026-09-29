import { describe, expect, it } from "vitest";
import { charterHelperRoleEnum } from "#/db/schema";
import {
	CHARTER_HELPER_ROLE_LABEL,
	CHARTER_HELPER_ROLES,
	charterProgressPercent,
	DEFAULT_MEMBERS_NEEDED,
	moveInOrder,
	OFFICIAL_REQUIREMENTS_URL,
	SEEDED_CHARTER_STEPS,
} from "./charter-dashboard";

describe("charter dashboard vocabulary (#943)", () => {
	it("restates the helper roles the database enum holds", () => {
		expect([...CHARTER_HELPER_ROLES]).toEqual(charterHelperRoleEnum.enumValues);
		expect(Object.keys(CHARTER_HELPER_ROLE_LABEL).sort()).toEqual(
			[...CHARTER_HELPER_ROLES].sort(),
		);
	});

	it("seeds the four common steps the issue names, in order", () => {
		expect(SEEDED_CHARTER_STEPS).toEqual([
			"Officers elected or appointed",
			"Charter dues collected",
			"Charter paperwork submitted to district",
			"Charter confirmed",
		]);
		expect(DEFAULT_MEMBERS_NEEDED).toBe(20);
	});

	it("links out to an https Toastmasters page rather than carrying its content", () => {
		expect(OFFICIAL_REQUIREMENTS_URL).toMatch(
			/^https:\/\/www\.toastmasters\.org\//,
		);
	});
});

describe("charterProgressPercent", () => {
	it("fills in proportion, rounded", () => {
		expect(charterProgressPercent(12, 20)).toBe(60);
		expect(charterProgressPercent(1, 3)).toBe(33);
	});
	it("stops at 100 past the target and at 0 for nothing", () => {
		expect(charterProgressPercent(25, 20)).toBe(100);
		expect(charterProgressPercent(0, 20)).toBe(0);
		expect(charterProgressPercent(5, 0)).toBe(0);
	});
});

describe("moveInOrder", () => {
	const ids = ["a", "b", "c"];
	it("swaps with the neighbour", () => {
		expect(moveInOrder(ids, "b", "up")).toEqual(["b", "a", "c"]);
		expect(moveInOrder(ids, "b", "down")).toEqual(["a", "c", "b"]);
	});
	it("leaves the order alone at either end or for an unknown id", () => {
		expect(moveInOrder(ids, "a", "up")).toEqual(ids);
		expect(moveInOrder(ids, "c", "down")).toEqual(ids);
		expect(moveInOrder(ids, "z", "up")).toEqual(ids);
	});
	it("does not mutate its input", () => {
		const input = [...ids];
		moveInOrder(input, "b", "up");
		expect(input).toEqual(ids);
	});
});
