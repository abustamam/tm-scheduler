import { describe, expect, it } from "vitest";
import { normalizePresentationUrl } from "./presentation-url";

describe("normalizePresentationUrl", () => {
	it("returns null for empty / blank / nullish", () => {
		expect(normalizePresentationUrl(undefined)).toBeNull();
		expect(normalizePresentationUrl(null)).toBeNull();
		expect(normalizePresentationUrl("")).toBeNull();
		expect(normalizePresentationUrl("   ")).toBeNull();
	});

	it("coerces a bare host to https", () => {
		expect(normalizePresentationUrl("docs.google.com/d/abc")).toBe(
			"https://docs.google.com/d/abc",
		);
		expect(normalizePresentationUrl("acme.com")).toBe("https://acme.com/");
	});

	it("keeps an explicit http(s) URL (trimmed)", () => {
		expect(normalizePresentationUrl("  https://acme.com/deck  ")).toBe(
			"https://acme.com/deck",
		);
		expect(normalizePresentationUrl("http://acme.com")).toBe(
			"http://acme.com/",
		);
	});

	it("rejects non-http schemes and junk", () => {
		expect(normalizePresentationUrl("ftp://acme.com/x")).toBeNull();
		expect(normalizePresentationUrl("javascript:alert(1)")).toBeNull();
		expect(normalizePresentationUrl("tbd")).toBeNull();
		expect(normalizePresentationUrl("n/a")).toBeNull();
	});
});
