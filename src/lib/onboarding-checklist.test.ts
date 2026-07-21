import { describe, expect, it } from "vitest";
import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";
import {
	buildOnboardingChecklistItems,
	CHECKLIST_MEMBER_THRESHOLD,
	onboardingDismissKey,
} from "./onboarding-checklist";

const ALL_DONE: OnboardingChecklistStatus = {
	clubSlug: "test-club",
	clubDetailsComplete: true,
	memberCount: 12,
	hasEnoughMembers: true,
	hasRecurrence: true,
	hasMeeting: true,
	hasOfficerTerm: true,
	isNewClub: false,
};

const NONE_DONE: OnboardingChecklistStatus = {
	clubSlug: "brand-new-club",
	clubDetailsComplete: false,
	memberCount: 2,
	hasEnoughMembers: false,
	hasRecurrence: false,
	hasMeeting: false,
	hasOfficerTerm: false,
	isNewClub: true,
};

describe("buildOnboardingChecklistItems", () => {
	it("emits the five data-backed rows in a fixed order", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		expect(items.map((i) => i.key)).toEqual([
			"club-details",
			"roster",
			"recurrence",
			"meetings",
			"officers",
		]);
	});

	it("deep-links each item to its real destination screen", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		const byKey = Object.fromEntries(items.map((i) => [i.key, i.to]));
		expect(byKey).toEqual({
			"club-details": "/admin/club-settings",
			roster: "/roster",
			recurrence: "/admin/schedule",
			meetings: "/admin/meetings/batch",
			officers: "/roster",
		});
	});

	it("marks every item complete when the status says so", () => {
		const items = buildOnboardingChecklistItems(ALL_DONE);
		expect(items.every((i) => i.complete)).toBe(true);
	});

	it("marks every item incomplete on a brand-new club", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		expect(items.every((i) => !i.complete)).toBe(true);
	});

	it("maps each field to its own item independently", () => {
		const mixed: OnboardingChecklistStatus = {
			...NONE_DONE,
			hasRecurrence: true,
			hasOfficerTerm: true,
		};
		const items = buildOnboardingChecklistItems(mixed);
		const byKey = Object.fromEntries(items.map((i) => [i.key, i.complete]));
		expect(byKey["club-details"]).toBe(false);
		expect(byKey.roster).toBe(false);
		expect(byKey.recurrence).toBe(true);
		expect(byKey.meetings).toBe(false);
		expect(byKey.officers).toBe(true);
	});

	it("mentions the member threshold in the roster item's copy", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		const roster = items.find((i) => i.key === "roster");
		expect(roster?.description).toContain(String(CHECKLIST_MEMBER_THRESHOLD));
	});
});

describe("onboardingDismissKey", () => {
	it("is namespaced and per-club", () => {
		expect(onboardingDismissKey("club-a")).toBe(
			"gavelup:onboarding-dismissed:club-a",
		);
		expect(onboardingDismissKey("club-b")).not.toBe(
			onboardingDismissKey("club-a"),
		);
	});
});
