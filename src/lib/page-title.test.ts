import { describe, expect, it } from "vitest";
import {
	navPageTitle,
	nextMeetingTitle,
	publicTitle,
	workspaceTitle,
} from "./page-title";

const CLUBS = [
	{ clubId: "club-a", name: "Sunrise Speakers" },
	{ clubId: "club-b", name: "Evening Orators" },
];

describe("workspaceTitle", () => {
	// protects=a signed-in tab names its page and the ACTIVE club, so five tabs are told apart (#1422)
	// fails_when=the title names the first club, or none, instead of the active one
	// no_claim=does not prove any route calls it; page-titles.guard.test.ts covers that
	it("names the page and the active club", () => {
		expect(
			workspaceTitle("Roster", { clubs: CLUBS, activeClubId: "club-b" }),
		).toBe("Roster · Evening Orators");
	});

	// protects=a club-less account still gets a title that names the product
	// fails_when=a null active club prints "undefined" or "null", or throws
	// no_claim=does not prove which accounts are club-less
	it("falls back to GavelUp with no active club", () => {
		expect(workspaceTitle("Roster", { clubs: [], activeClubId: null })).toBe(
			"Roster · GavelUp",
		);
	});

	// protects=an active id naming none of the account's clubs reads as GavelUp, never a stale or blank club
	// fails_when=the lookup result is dereferenced unguarded or the first club is substituted
	// no_claim=does not prove the router ever supplies such an id
	it("falls back to GavelUp when the active club is not one of the account's", () => {
		expect(
			workspaceTitle("Dues", { clubs: CLUBS, activeClubId: "club-gone" }),
		).toBe("Dues · GavelUp");
	});
});

describe("publicTitle", () => {
	// protects=pages with no club context (sign-in, claim, consent) end in the product name
	// fails_when=the separator or brand drifts from workspaceTitle's no-club form
	// no_claim=does not prove each public route's label
	it("is the no-club form of workspaceTitle", () => {
		expect(publicTitle("Sign in")).toBe("Sign in · GavelUp");
		expect(publicTitle("Sign in")).toBe(
			workspaceTitle("Sign in", { clubs: [], activeClubId: null }),
		);
	});
});

describe("registry-backed titles", () => {
	// protects=a registered route's title carries the sidebar's label, read from NAV_DESTINATIONS, and an alsoActiveOn sibling carries its entry's
	// fails_when=navPageTitle retypes a label, or resolves a sibling route to nothing
	// no_claim=does not prove any route uses it; page-titles.guard.test.ts does
	it("navPageTitle reads the registry label", () => {
		const ctx = { clubs: CLUBS, activeClubId: "club-a" };
		expect(navPageTitle("/admin/dues", ctx)).toBe("Dues · Sunrise Speakers");
		expect(navPageTitle("/admin/meetings/batch", ctx)).toBe(
			"New meetings · Sunrise Speakers",
		);
	});

	// protects=the public next-meeting link's tab names the club, with the registered "Next meeting" label
	// fails_when=the club name is dropped or the label is retyped
	// no_claim=does not prove the route's redirect behaviour
	it("nextMeetingTitle names the club", () => {
		expect(nextMeetingTitle("Sunrise Speakers")).toBe(
			"Next meeting · Sunrise Speakers",
		);
	});
});
