// #495 — `clubLogoUrl` has no direct test elsewhere: both real call sites
// (`club-settings.tsx`'s preview and `club.$clubId_.meeting.$meetingId.print.tsx`'s
// loader) either mock it away or were themselves untested, so every branch below
// — the null/undefined short-circuit, the Date-vs-ISO-string input shapes, and
// the NaN guard on an unparseable string — had zero coverage before this file.
import { describe, expect, it } from "vitest";
import { clubLogoUrl } from "./club-logo-url";

describe("clubLogoUrl", () => {
	it("returns null when updatedAt is null (no logo uploaded)", () => {
		expect(clubLogoUrl("abc-123", null)).toBeNull();
	});

	it("returns null when updatedAt is undefined", () => {
		expect(clubLogoUrl("abc-123", undefined)).toBeNull();
	});

	it("builds a versioned URL from a Date, using its epoch milliseconds", () => {
		const updatedAt = new Date("2026-07-31T00:00:00.000Z");
		expect(clubLogoUrl("abc-123", updatedAt)).toBe(
			`/api/club/abc-123/logo?v=${updatedAt.getTime()}`,
		);
	});

	// Server fns serialize Date columns to ISO strings over the wire — this is
	// the shape `getClubLogoMeta`'s caller actually receives, not a Date object.
	it("builds the same URL from the equivalent ISO string (the server-fn wire shape)", () => {
		const iso = "2026-07-31T00:00:00.000Z";
		expect(clubLogoUrl("abc-123", iso)).toBe(
			`/api/club/abc-123/logo?v=${new Date(iso).getTime()}`,
		);
	});

	// The NaN guard: `new Date("not-a-date").getTime()` is NaN, and without the
	// guard this would ship a URL literally ending "?v=NaN" — which still isn't
	// the CURRENT version, so it would also permanently lose the immutable
	// Cache-Control the route grants only to a matching `?v=`.
	it("returns null for an unparseable date string instead of building a ?v=NaN URL", () => {
		expect(clubLogoUrl("abc-123", "not-a-date")).toBeNull();
	});

	it("interpolates the given clubId into the path", () => {
		const updatedAt = new Date("2026-01-01T00:00:00.000Z");
		expect(clubLogoUrl("some-other-club-id", updatedAt)).toBe(
			`/api/club/some-other-club-id/logo?v=${updatedAt.getTime()}`,
		);
	});
});
