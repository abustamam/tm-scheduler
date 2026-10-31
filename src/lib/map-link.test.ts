import { describe, expect, it } from "vitest";
import { mapLink } from "#/lib/map-link";

describe("mapLink", () => {
	/*
	 * protects: a street address gets a maps search link with the address encoded.
	 * fails_when: the query is not URI-encoded, or the API base changes.
	 * no_claim: says nothing about whether Google finds the address.
	 */
	it("links a street address", () => {
		expect(mapLink("12 Main St, Springfield")).toBe(
			"https://www.google.com/maps/search/?api=1&query=12%20Main%20St%2C%20Springfield",
		);
	});

	// protects=AC2: no link for a URL location, in any of its common spellings.
	// fails_when=a pasted meeting URL is sent to a map search.
	it("omits the link for a URL", () => {
		expect(mapLink("https://zoom.us/j/123")).toBeNull();
		expect(mapLink("HTTP://meet.example/abc")).toBeNull();
		expect(mapLink("  www.example.com/room ")).toBeNull();
	});

	// protects=blank and missing locations produce no link.
	it("omits the link for nothing", () => {
		expect(mapLink(null)).toBeNull();
		expect(mapLink(undefined)).toBeNull();
		expect(mapLink("   ")).toBeNull();
	});

	// protects=a room name that merely contains "http" is still an address.
	it("keeps a place whose name starts like a word, not a scheme", () => {
		expect(mapLink("Httpville Library")).not.toBeNull();
	});
});
