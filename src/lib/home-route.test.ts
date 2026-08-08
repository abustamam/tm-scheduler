import { describe, expect, it } from "vitest";
import { homeRedirectTarget } from "./home-route";

describe("homeRedirectTarget", () => {
	it("sends an admin-role member to the officer home", () => {
		expect(homeRedirectTarget({ clubRole: "admin", officerCount: 0 })).toBe(
			"/officers",
		);
	});

	it("sends an elected officer (no admin role) to the officer home", () => {
		expect(homeRedirectTarget({ clubRole: "member", officerCount: 2 })).toBe(
			"/officers",
		);
	});

	// #542: members used to land on /roster ("Manage · Roster", Export CSV,
	// Merge duplicates in view). Their dashboard is the member home.
	it("sends a plain member to their dashboard", () => {
		expect(homeRedirectTarget({ clubRole: "member", officerCount: 0 })).toBe(
			"/dashboard",
		);
	});

	it("defaults a member with no known role to the dashboard", () => {
		expect(homeRedirectTarget({ clubRole: null, officerCount: 0 })).toBe(
			"/dashboard",
		);
	});
});
