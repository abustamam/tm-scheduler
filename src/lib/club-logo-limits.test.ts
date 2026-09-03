/**
 * ABSOLUTE pins on the club-logo limits (#504).
 *
 * `club-logo-limits.guard.test.ts` proves everyone reads the same symbol.
 * That is necessary and not sufficient: once every consumer imports these,
 * every OTHER test about them is stated relative to them, and a test stated
 * relative to the constant it guards passes for every value of that constant —
 * including one that reintroduces the bug the constant exists to prevent.
 * Raising `MAX_LOGO_DIMENSION` to 20,000 would keep the whole suite green while
 * putting a quarter-gigabyte decode back on a public, unauthenticated endpoint.
 *
 * So this file is the one place that states the numbers themselves, as ceilings
 * picked by measurement rather than by taste. Raising one is a deliberate edit
 * here with a new measurement behind it.
 */
import { describe, expect, it } from "vitest";
import {
	ALLOWED_LOGO_MIME_TYPES,
	isAllowedLogoMime,
	MAX_ENCODED_LENGTH,
	MAX_LOGO_BYTES,
	MAX_LOGO_DIMENSION,
	MAX_LOGO_KB,
} from "#/lib/club-logo-limits";

/** base64 encodes 3 bytes as 4 chars, padded — so exactly this many chars. */
const base64LengthOf = (bytes: number) => Math.ceil(bytes / 3) * 4;

describe("club-logo limits — absolute ceilings", () => {
	it("caps decoded bytes at 256 KiB or less", () => {
		// Storage and transfer. Every club row carries one of these as `bytea`,
		// and the public GET route serves it verbatim.
		expect(MAX_LOGO_BYTES).toBeLessThanOrEqual(256 * 1024);
		expect(MAX_LOGO_BYTES).toBeGreaterThan(0);
	});

	it("caps pixel dimensions at 2000px or less", () => {
		// The measurements behind this number are on `MAX_LOGO_DIMENSION` itself;
		// they are not repeated here, so a re-measurement has one site to update.
		// The short version: bytes do not bound decode cost, and this is the only
		// thing that does.
		expect(MAX_LOGO_DIMENSION).toBeLessThanOrEqual(2000);
		expect(MAX_LOGO_DIMENSION).toBeGreaterThan(0);
	});

	it("keeps the encoded cap above the exact encoding of the decoded cap", () => {
		// The two caps are an outer/inner pair, not one number written twice.
		// If the encoded cap were tightened to the exact base64 length of
		// MAX_LOGO_BYTES (349,528 chars for 256 KiB), the decoded check could
		// never fire: every over-cap upload would be rejected by the outer check
		// with the vaguer "That file is too large to upload." instead of
		// "Logo must be 256 KB or smaller.", and
		// `club-logo-logic.integration.test.ts`'s decoded-cap case would be
		// unreachable rather than merely failing.
		expect(MAX_ENCODED_LENGTH).toBeGreaterThan(base64LengthOf(MAX_LOGO_BYTES));
	});

	it("keeps the encoded cap from becoming the real request-size limit", () => {
		// It bounds the string the server buffers BEFORE anything is decoded, so
		// it — not MAX_LOGO_BYTES — is what a caller can actually make the
		// process hold. Slack over the exact encoding is fine; a multiple of it
		// is a different limit wearing the same name.
		expect(MAX_ENCODED_LENGTH).toBeLessThanOrEqual(
			base64LengthOf(MAX_LOGO_BYTES) * 1.05,
		);
	});

	it("allows exactly PNG and JPEG", () => {
		// Widening this is not a config change. `matchesMagicBytes` and
		// `readImageDimensions` (`#/lib/image-dimensions`) each handle exactly these
		// two formats and dispatch on the declared MIME, so a third entry here
		// would sail past both — an SVG, in particular, is the case ADR-0024's
		// trademark review specifically required be rejected.
		expect([...ALLOWED_LOGO_MIME_TYPES]).toEqual(["image/png", "image/jpeg"]);
	});

	it("MAX_LOGO_KB is a whole number of KiB, capped like the bytes it renders", () => {
		// `toBe(MAX_LOGO_BYTES / 1024)` was here first and was worthless: that IS
		// the definition, so the assertion read `x === x` and passed for every
		// value — the exact trap this file exists to avoid, inside the file that
		// warns about it. The pin is absolute, and the integer check is the one
		// that does real work: this number reaches users in three messages, and a
		// cap that is not a multiple of 1024 would render "up to 292.96875 KB".
		expect(MAX_LOGO_KB).toBeLessThanOrEqual(256);
		expect(MAX_LOGO_KB).toBeGreaterThan(0);
		expect(Number.isInteger(MAX_LOGO_KB)).toBe(true);
	});
});

describe("isAllowedLogoMime", () => {
	it("accepts each allowed type", () => {
		for (const mime of ALLOWED_LOGO_MIME_TYPES) {
			expect(isAllowedLogoMime(mime)).toBe(true);
		}
	});

	it("rejects an image type that is not on the list", () => {
		expect(isAllowedLogoMime("image/svg+xml")).toBe(false);
		expect(isAllowedLogoMime("image/webp")).toBe(false);
	});

	it("rejects a near-miss rather than matching loosely", () => {
		// A prefix/substring check would pass all three of these.
		expect(isAllowedLogoMime("image/png; charset=binary")).toBe(false);
		expect(isAllowedLogoMime("image/pn")).toBe(false);
		expect(isAllowedLogoMime("IMAGE/PNG")).toBe(false);
	});

	it("rejects an empty declared type", () => {
		// A browser hands over "" for a file it can't classify — that must not
		// read as "no objection".
		expect(isAllowedLogoMime("")).toBe(false);
	});
});
