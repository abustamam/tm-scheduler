import { describe, expect, it, vi } from "vitest";

// The logic module imports the pooled client; nothing here reaches it.
vi.mock("#/db", () => ({ db: {} }));

const { parseDemoAccountEmail } = await import("./demo-reset-logic");

// protects=the one account the demo club is built around is read off the env
//   var as one trimmed, lowercased address, and nothing else is read as one;
// fails_when=an unset, blank, comma-separated or whitespace-containing value is
//   returned as an address (a list or a typo would silently pick an account), or
//   a padded or mixed-case address is returned as typed (the account lookup is
//   by exact lowercase address);
// no_claim=the address is not checked for being deliverable or for existing as
//   a user; the integration suite covers the lookup.
describe("parseDemoAccountEmail (#1199)", () => {
	it("returns null when the value is unset, null or blank", () => {
		expect(parseDemoAccountEmail(undefined)).toBeNull();
		expect(parseDemoAccountEmail(null)).toBeNull();
		expect(parseDemoAccountEmail("")).toBeNull();
		expect(parseDemoAccountEmail("   \t ")).toBeNull();
	});

	it("trims and lowercases a single address", () => {
		expect(parseDemoAccountEmail("  Me+Demo@Example.COM \n")).toBe(
			"me+demo@example.com",
		);
	});

	it("returns null for a list", () => {
		expect(parseDemoAccountEmail("a@x.org,b@x.org")).toBeNull();
		expect(parseDemoAccountEmail("a@x.org, b@x.org")).toBeNull();
	});

	it("returns null for an address with whitespace inside it", () => {
		expect(parseDemoAccountEmail("a b@x.org")).toBeNull();
		expect(parseDemoAccountEmail("a@x.org b@x.org")).toBeNull();
	});
});
