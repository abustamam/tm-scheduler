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

	it("sends a plain member to the roster", () => {
		expect(homeRedirectTarget({ clubRole: "member", officerCount: 0 })).toBe(
			"/roster",
		);
	});

	it("defaults a member with no known role to the roster", () => {
		expect(homeRedirectTarget({ clubRole: null, officerCount: 0 })).toBe(
			"/roster",
		);
	});
});
