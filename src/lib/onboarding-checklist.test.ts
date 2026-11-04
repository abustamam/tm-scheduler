import { describe, expect, it } from "vitest";
import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";
import {
	buildOnboardingChecklistItems,
	CHECKLIST_MEMBER_THRESHOLD,
	isNewClubFor,
	officialRosterComplete,
	onboardingDismissKey,
	onboardingPathKey,
	resolveOnboardingPath,
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
	officialRosterCount: 12,
	hasOfficialRoster: true,
	hasImport: true,
	hasAppliedImport: true,
	hasUpcomingMeeting: true,
	isNewClubEasySpeak: false,
	canRunImport: true,
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
	officialRosterCount: 0,
	hasOfficialRoster: false,
	hasImport: false,
	hasAppliedImport: false,
	hasUpcomingMeeting: false,
	isNewClubEasySpeak: true,
	canRunImport: true,
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

// protects=the Easy-Speak roster row's boundary; fails_when=an empty roster or a
// thin official share clears it; no_claim=the DB query that supplies the counts.
describe("officialRosterComplete", () => {
	it("is incomplete on an empty roster", () => {
		expect(officialRosterComplete(0, 0)).toBe(false);
	});
	it("is incomplete with 4 of 6 official and complete with 5 of 6", () => {
		expect(officialRosterComplete(4, 6)).toBe(false);
		expect(officialRosterComplete(5, 6)).toBe(true);
	});
	it("is complete when a 3-member club is entirely official", () => {
		expect(officialRosterComplete(3, 3)).toBe(true);
		expect(officialRosterComplete(2, 3)).toBe(false);
	});
});

// protects=data beats storage; fails_when=a stored choice overrides an import or a
// stale value switches paths; no_claim=localStorage itself.
describe("resolveOnboardingPath / isNewClubFor", () => {
	it("is fresh with no import and no stored choice", () => {
		expect(resolveOnboardingPath({ hasImport: false }, null)).toBe("fresh");
		expect(resolveOnboardingPath({ hasImport: false }, "junk")).toBe("fresh");
	});
	it("honours the stored choice only before an import", () => {
		expect(resolveOnboardingPath({ hasImport: false }, "easy-speak")).toBe(
			"easy-speak",
		);
	});
	it("an import forces Easy-Speak whatever is stored", () => {
		expect(resolveOnboardingPath({ hasImport: true }, null)).toBe("easy-speak");
	});
	it("graduation reads the path's own flag", () => {
		const s = { isNewClub: true, isNewClubEasySpeak: false };
		expect(isNewClubFor(s, "fresh")).toBe(true);
		expect(isNewClubFor(s, "easy-speak")).toBe(false);
	});
	it("namespaces the path key per club", () => {
		expect(onboardingPathKey("a")).toBe("gavelup:onboarding-path:a");
	});
});

// protects=the seven Easy-Speak rows and who may act on the import steps;
// fails_when=order, keys, the generate row or the lock drift.
describe("buildOnboardingChecklistItems (easy-speak)", () => {
	it("lists seven rows in order with no generate-meetings row", () => {
		const keys = buildOnboardingChecklistItems(NONE_DONE, "easy-speak").map(
			(i) => i.key,
		);
		expect(keys).toEqual([
			"club-details",
			"official-roster",
			"history",
			"upcoming",
			"recurrence",
			"invite",
			"officers",
		]);
	});
	it("locks only rows 3 and 4, and only when the viewer cannot run the import", () => {
		const locked = buildOnboardingChecklistItems(
			{ ...NONE_DONE, canRunImport: false },
			"easy-speak",
		)
			.filter((i) => i.locked)
			.map((i) => i.key);
		expect(locked).toEqual(["history", "upcoming"]);
		expect(
			buildOnboardingChecklistItems(NONE_DONE, "easy-speak").some(
				(i) => i.locked,
			),
		).toBe(false);
	});
	it("ticks each new row from its own flag", () => {
		const items = buildOnboardingChecklistItems(
			{
				...NONE_DONE,
				hasOfficialRoster: true,
				hasAppliedImport: true,
				hasUpcomingMeeting: true,
			},
			"easy-speak",
		);
		const done = items.filter((i) => i.complete).map((i) => i.key);
		expect(done).toEqual(["official-roster", "history", "upcoming"]);
	});
});
