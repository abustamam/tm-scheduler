import { describe, expect, it, vi } from "vitest";

// The logic module imports the pooled client; nothing here reaches it.
vi.mock("#/db", () => ({ db: {} }));

const { demoKeepRule, demoProgramYear, demoVisitDay, parseDemoAccountEmail } =
	await import("./demo-reset-logic");

describe("parseDemoAccountEmail (#1199)", () => {
	// protects=an unset, null or blank env var is "not configured", not an address;
	// fails_when=any of the three is returned as a string, so a build would look up
	//   an account named "";
	// no_claim=the address is not checked for being deliverable or for existing as
	//   a user; the integration suite covers the lookup.
	it("returns null when the value is unset, null or blank", () => {
		expect(parseDemoAccountEmail(undefined)).toBeNull();
		expect(parseDemoAccountEmail(null)).toBeNull();
		expect(parseDemoAccountEmail("")).toBeNull();
		expect(parseDemoAccountEmail("   \t ")).toBeNull();
	});

	// protects=the account lookup is by exact lowercase address, so a padded or
	//   mixed-case value is normalised before it is used;
	// fails_when=the padding or the case is returned as typed;
	// no_claim=none beyond protects.
	it("trims and lowercases a single address", () => {
		expect(parseDemoAccountEmail("  Me+Demo@Example.COM \n")).toBe(
			"me+demo@example.com",
		);
	});

	// protects=a comma-separated list is never read as one account;
	// fails_when=a list returns an address (the first, or the whole string), so a
	//   list in the env var would silently pick one account;
	// no_claim=none beyond protects.
	it("returns null for a list", () => {
		expect(parseDemoAccountEmail("a@x.org,b@x.org")).toBeNull();
		expect(parseDemoAccountEmail("a@x.org, b@x.org")).toBeNull();
	});

	// protects=a typo with whitespace inside is not read as an address;
	// fails_when=an address with an inner space is returned;
	// no_claim=none beyond protects.
	it("returns null for an address with whitespace inside it", () => {
		expect(parseDemoAccountEmail("a b@x.org")).toBeNull();
		expect(parseDemoAccountEmail("a@x.org b@x.org")).toBeNull();
	});
});

describe("demoKeepRule (#1199)", () => {
	const rule = demoKeepRule("demo@club.org");
	const account = (email: string) => ({ id: "u", email });

	// protects=a rebuild keeps every deliverable account and the demo account, and
	//   only the fixture's reserved-address accounts are removable;
	// fails_when=a reserved address is kept, a deliverable one is not, or the demo
	//   account is lost (in any case, or when its own address is reserved);
	// no_claim=the rule is evaluated by `deleteClubCore` on locked users; the
	//   integration suite covers that placement.
	it("keeps deliverable accounts and the demo account, never other reserved ones", () => {
		expect(rule(account("real@club.org"))).toBe(true);
		expect(rule(account("Demo@Club.org"))).toBe(true);
		expect(rule(account("priya@example.com"))).toBe(false);
		expect(rule(account("x@club.test"))).toBe(false);
		expect(demoKeepRule("me@example.com")(account("ME@example.com"))).toBe(
			true,
		);
	});
});

describe("demoVisitDay (#1278)", () => {
	// protects=mid-year the visit is 14 calendar days before today in Chicago;
	// fails_when=the UTC date is used (this instant is Nov 14 in Chicago) or the
	//   lead is not 14 days;
	// no_claim=none beyond protects.
	it("is 14 days back in America/Chicago, mid-year", () => {
		expect(demoVisitDay(new Date("2026-11-15T03:00:00Z"), 2026)).toBe(
			"2026-10-31",
		);
		expect(demoVisitDay(new Date("2026-11-15T18:00:00Z"), 2026)).toBe(
			"2026-11-01",
		);
	});

	// protects=on July 5 the date is raised to the program year's first day;
	// fails_when=June 21, a date outside the program year, is returned;
	// no_claim=none beyond protects.
	it("is July 1 on July 5", () => {
		expect(demoVisitDay(new Date("2026-07-05T17:00:00Z"), 2026)).toBe(
			"2026-07-01",
		);
	});

	// protects=exactly 14 days after July 1 is not clamped, and a DST change in the
	//   window does not move the date (calendar arithmetic, not 14 x 24h);
	// fails_when=the 14th day is raised to July 1, or the March DST shift makes it
	//   a day early or late;
	// no_claim=none beyond protects.
	it("does not clamp on July 15, and DST does not shift the date", () => {
		expect(demoVisitDay(new Date("2026-07-15T17:00:00Z"), 2026)).toBe(
			"2026-07-01",
		);
		expect(demoVisitDay(new Date("2026-07-16T17:00:00Z"), 2026)).toBe(
			"2026-07-02",
		);
		expect(demoVisitDay(new Date("2027-03-15T17:00:00Z"), 2026)).toBe(
			"2027-03-01",
		);
	});
});

describe("demoProgramYear (#1278)", () => {
	// protects=the program year follows the calendar day in America/Chicago, the
	//   same day `demoVisitDay` uses: 01:00Z on July 1 is still June 30 in Chicago;
	// fails_when=the server clock's zone decides (UTC names 2027) so the visit is
	//   dated in the future of its own program year's window;
	// no_claim=none beyond protects.
	it("is still the previous program year at 2027-07-01T01:00Z", () => {
		const now = new Date("2027-07-01T01:00:00Z");
		expect(demoProgramYear(now)).toBe(2026);
		expect(demoVisitDay(now, demoProgramYear(now))).toBe("2027-06-16");
	});

	// protects=once Chicago reaches July 1 the new year starts;
	// fails_when=the boundary is off by a day in either direction;
	// no_claim=none beyond protects.
	it("is the new program year once Chicago reaches July 1", () => {
		expect(demoProgramYear(new Date("2027-07-01T06:00:00Z"))).toBe(2027);
		expect(demoProgramYear(new Date("2026-11-15T18:00:00Z"))).toBe(2026);
	});
});
