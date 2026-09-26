import { describe, expect, it } from "vitest";
import {
	crumbOf,
	destinationFor,
	NAV_DESTINATIONS,
	NAV_GROUPS,
	navLabel,
	visibleDestinations,
} from "./nav-destinations";
import { COMMON_TASKS, OFFICER_TASKS, officerTaskTitle } from "./officer-tasks";
import { OFFICER_POSITIONS } from "./officers";

const MEMBER = { hasOffice: false, isOfficer: false, isSuperadmin: false };
const ADMIN_NO_OFFICE = {
	hasOffice: false,
	isOfficer: true,
	isSuperadmin: false,
};
const OFFICE_HOLDER = { hasOffice: true, isOfficer: true, isSuperadmin: false };
const EVERYTHING = { hasOffice: true, isOfficer: true, isSuperadmin: true };

const keysIn = (grants: typeof MEMBER, group: string) =>
	visibleDestinations(grants)
		.filter((d) => d.group === group)
		.map((d) => d.label);

describe("NAV_GROUPS", () => {
	it("orders the groups by frequency, with only Setup collapsible", () => {
		expect(NAV_GROUPS.map((g) => g.label)).toEqual([
			"Meetings",
			"Officers",
			"Setup",
			"Me",
			"Platform",
		]);
		expect(NAV_GROUPS.filter((g) => g.collapsible).map((g) => g.key)).toEqual([
			"setup",
		]);
	});
});

describe("visibleDestinations", () => {
	it("gives a plain member Meetings and Me only", () => {
		const groups = new Set(visibleDestinations(MEMBER).map((d) => d.group));
		expect([...groups]).toEqual(["meetings", "me"]);
		expect(keysIn(MEMBER, "meetings")).toEqual([
			"Sign-up sheet",
			"Next meeting",
			"Past meetings",
			"Roster",
			"Activity",
		]);
		expect(keysIn(MEMBER, "me")).toEqual([
			"My dashboard",
			"My roles",
			"Account settings",
			"Resources",
		]);
	});

	it("gives an office holder 11 items in Meetings + Officers, and Setup", () => {
		expect(keysIn(OFFICE_HOLDER, "officers")).toEqual([
			"Officer home",
			"VP Education",
			"VP Membership",
			"DCP scoreboard",
			"Dues",
			"Action items",
		]);
		expect(
			keysIn(OFFICE_HOLDER, "meetings").length +
				keysIn(OFFICE_HOLDER, "officers").length,
		).toBe(11);
		expect(keysIn(OFFICE_HOLDER, "setup")).toEqual([
			"New meetings",
			"Recurring schedule",
			"Meeting roles",
			"Club settings",
			"Pathways sync",
		]);
		expect(keysIn(OFFICE_HOLDER, "platform")).toEqual([]);
	});

	it("hides Officer home from an admin holding no office (10 items)", () => {
		expect(keysIn(ADMIN_NO_OFFICE, "officers")).not.toContain("Officer home");
		expect(
			keysIn(ADMIN_NO_OFFICE, "meetings").length +
				keysIn(ADMIN_NO_OFFICE, "officers").length,
		).toBe(10);
	});

	it("shows Platform to superadmins only", () => {
		expect(keysIn(EVERYTHING, "platform")).toEqual([
			"Superadmin",
			"Duplicate people",
		]);
		expect(visibleDestinations(EVERYTHING)).toHaveLength(
			NAV_DESTINATIONS.length,
		);
	});
});

describe("destinationFor", () => {
	it("matches a to exactly, with a trailing slash, and as a / prefix", () => {
		expect(destinationFor("/roster")?.key).toBe("roster");
		expect(destinationFor("/roster/")?.key).toBe("roster");
		expect(destinationFor("/meetings/abc")?.key).toBe("past-meetings");
		// A prefix that is not followed by `/` is a different page.
		expect(destinationFor("/members/abc")).toBeUndefined();
		expect(destinationFor("/schedule")?.key).toBe("sign-up-sheet");
		expect(destinationFor("/admin/schedule")?.key).toBe("recurring-schedule");
	});

	it("maps an alsoActiveOn sibling to its entry", () => {
		expect(destinationFor("/admin/meetings/batch")?.key).toBe("new-meetings");
		expect(destinationFor("/admin/pathways-sync")?.key).toBe("pathways-sync");
		expect(navLabel("/admin/meetings/batch")).toBe("New meetings");
		const batch = destinationFor("/admin/meetings/batch");
		expect(batch && crumbOf(batch)).toBe("Setup · New meetings");
	});

	it("honours exact, and lets the longest match win", () => {
		expect(destinationFor("/superadmin")?.key).toBe("superadmin");
		expect(destinationFor("/superadmin/")?.key).toBe("superadmin");
		expect(destinationFor("/superadmin/club-1")).toBeUndefined();
		expect(destinationFor("/superadmin/duplicate-people")?.key).toBe(
			"duplicate-people",
		);
	});

	it("returns undefined for a path that is not a destination", () => {
		expect(destinationFor("/")).toBeUndefined();
		expect(destinationFor("/admin")).toBeUndefined();
		expect(destinationFor("/club/x/meeting/y")).toBeUndefined();
	});
});

describe("Officer home card titles (#911)", () => {
	const allTasks = [
		...COMMON_TASKS,
		...OFFICER_POSITIONS.flatMap((p) => OFFICER_TASKS[p]),
	];

	it("titles every card with its destination's registry label", () => {
		for (const task of allTasks) {
			expect(officerTaskTitle(task)).toBe(destinationFor(task.to)?.label);
		}
		expect(officerTaskTitle({ description: "", to: "/activity" })).toBe(
			"Activity",
		);
	});

	it("keeps the per-office descriptions", () => {
		for (const task of allTasks)
			expect(task.description.length).toBeGreaterThan(0);
		const vpe = OFFICER_TASKS.vp_education;
		const batch = vpe.find((t) => t.to === "/admin/meetings/batch");
		expect(batch && officerTaskTitle(batch)).toBe("New meetings");
		expect(batch?.description).toBe("Create several meetings at once.");
		expect(vpe.find((t) => t.to === "/admin/meetings/new")?.description).toBe(
			"Add one meeting.",
		);
	});
});
