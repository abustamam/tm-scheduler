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
	invitedMemberCount: 12,
	hasInvitedMembers: true,
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
	invitedMemberCount: 0,
	hasInvitedMembers: false,
	hasRecurrence: false,
	hasMeeting: false,
	hasOfficerTerm: false,
	isNewClub: true,
};

describe("buildOnboardingChecklistItems", () => {
	it("emits the six data-backed rows in a fixed order", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		expect(items.map((i) => i.key)).toEqual([
			"club-details",
			"roster",
			"invite",
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
			invite: "/roster",
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
		expect(byKey.invite).toBe(false);
		expect(byKey.recurrence).toBe(true);
		expect(byKey.meetings).toBe(false);
		expect(byKey.officers).toBe(true);
	});

	// The two roster-shaped rows read DIFFERENT fields, and the pair a large but
	// un-invited club produces is the one that matters: "Import your roster" is
	// done, "Invite your members" is not. Reading `hasEnoughMembers` for both
	// would pass every other case in this file.
	it("the invite row tracks hasInvitedMembers, not the roster size", () => {
		const rosteredButUninvited: OnboardingChecklistStatus = {
			...NONE_DONE,
			memberCount: 8,
			hasEnoughMembers: true,
			invitedMemberCount: 0,
			hasInvitedMembers: false,
		};
		const byKey = Object.fromEntries(
			buildOnboardingChecklistItems(rosteredButUninvited).map((i) => [
				i.key,
				i.complete,
			]),
		);
		expect(byKey.roster).toBe(true);
		expect(byKey.invite).toBe(false);

		const invited = buildOnboardingChecklistItems({
			...rosteredButUninvited,
			invitedMemberCount: 8,
			hasInvitedMembers: true,
		});
		expect(invited.find((i) => i.key === "invite")?.complete).toBe(true);
	});

	it("mentions the member threshold in the roster item's copy", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		const roster = items.find((i) => i.key === "roster");
		expect(roster?.description).toContain(String(CHECKLIST_MEMBER_THRESHOLD));
	});

	// The club-details row is the only place the setup flow names the time zone,
	// and #716 made it a provisioning field — so the copy has to send an officer
	// checking a wrong zone to the screen that can fix it.
	it("names the time zone in the club-details item's copy", () => {
		const items = buildOnboardingChecklistItems(NONE_DONE);
		const details = items.find((i) => i.key === "club-details");
		expect(details?.description).toMatch(/time zone/i);
		expect(details?.to).toBe("/admin/club-settings");
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
