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

	/**
	 * The deceptive-link arm (#731). `https://zoom.us@evil.example.com/j/123`
	 * parses to hostname `evil.example.com` with username `zoom.us`, and before
	 * this arm the function returned it unchanged — so a reminder email whose
	 * link TEXT is its own href read as a Zoom link and went somewhere else.
	 *
	 * Asserted through the hostname as well as the null, so the test states what
	 * is actually wrong with the input rather than just pinning a return value.
	 */
	describe("credentials in the URL (#731)", () => {
		it("documents WHY: the host is what follows the @, not what precedes it", () => {
			// The premise. If this ever stops holding, the arm below is guarding
			// something that no longer exists and should be re-derived, not kept.
			expect(new URL("https://zoom.us@evil.example.com/j/123").hostname).toBe(
				"evil.example.com",
			);
		});

		it("rejects a username", () => {
			expect(
				normalizePresentationUrl("https://zoom.us@evil.example.com/j/123"),
			).toBeNull();
		});

		it("rejects a username and password", () => {
			expect(
				normalizePresentationUrl(
					"https://zoom.us:meeting@evil.example.com/j/123",
				),
			).toBeNull();
		});

		it("rejects it on the BARE-HOST path too", () => {
			// The scheme is prepended before parsing, so the same string without
			// `https://` reaches `new URL()` in the identical shape. A guard placed
			// only on explicitly-schemed input would miss this half entirely.
			expect(
				normalizePresentationUrl("zoom.us@evil.example.com/j/123"),
			).toBeNull();
		});

		it("still accepts an ordinary link with an @ in the PATH", () => {
			// `@` is legal after the host and is not userinfo. Over-rejecting here
			// would break real calendar and doc links.
			expect(normalizePresentationUrl("https://acme.com/u/a@b.com")).toBe(
				"https://acme.com/u/a@b.com",
			);
		});
	});
});
