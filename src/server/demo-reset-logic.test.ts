import { describe, expect, it, vi } from "vitest";

// The logic module imports the pooled client; nothing here reaches it.
vi.mock("#/db", () => ({ db: {} }));

const { demoKeepRule, parseDemoAccountEmail } = await import(
	"./demo-reset-logic"
);

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
