/**
 * Unit tests for the image-header validators behind the pixel-dimension cap (#496).
 *
 * These are pure functions, but they were originally reachable only through the
 * DB-gated integration suite — which SKIPS entirely without `TEST_DATABASE_URL`,
 * so on a plain `bun run test` nothing exercised them at all. That gap hid two
 * separate bugs, the second of which was worse than the one the cap was added
 * to fix:
 *
 *   1. The JPEG walker mis-parsed marker segments.
 *   2. The PNG side was a fixed-offset PEEK, not a validator. It read bytes
 *      16-24 and returned them, while the decoder that actually runs (`png-js`)
 *      walks the whole chunk list — with a signed length read, a skip that can
 *      move backwards, and last-IHDR-wins. A 45-byte file passed the gate as
 *      1x1 and made the decoder loop forever on a public endpoint.
 *
 * So the assertions here are about STRUCTURE, not just about dimensions: a file
 * whose chunk list we cannot read the same way the decoder will must be
 * rejected, even when a plausible width and height are sitting at the right
 * offsets.
 *
 * The parser moved to `#/lib/image-dimensions` in #504 so the browser could run
 * it too, and this file moved with it. `readImageDimensions` now imports
 * directly; only `isDecodeSafe` (which combines it with the cap and lives with
 * the DB-touching logic) still needs the `#/db` stub and the dynamic import.
 * Nothing here touches a database — the stub keeps these in the default suite.
 */
import { describe, expect, it, vi } from "vitest";

import { readImageDimensions } from "#/lib/image-dimensions";

vi.mock("#/db", () => ({ db: {} }));

const { isDecodeSafe } = await import("#/server/club-logo-logic");

// ---------------------------------------------------------------------------
// Builders — real files with real chunk structure, not a magic prefix and fill.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** length(4) + type(4) + data + crc(4). `declaredLength` overrides the real one. */
function chunk(
	type: string,
	data: Buffer = Buffer.alloc(0),
	declaredLength?: number,
): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE((declaredLength ?? data.length) >>> 0);
	return Buffer.concat([
		len,
		Buffer.from(type, "ascii"),
		data,
		Buffer.alloc(4), // CRC — never checked by us or by png-js
	]);
}

function ihdrData(width: number, height: number): Buffer {
	const d = Buffer.alloc(13);
	d.writeUInt32BE(width, 0);
	d.writeUInt32BE(height, 4);
	d[8] = 8; // bit depth
	d[9] = 6; // colour type (RGBA)
	return d;
}

function png(width: number, height: number, ...extra: Buffer[]): Buffer {
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdrData(width, height)),
		...extra,
		chunk("IEND"),
	]);
}

function segment(marker: number, payload: Buffer): Buffer {
	const length = Buffer.alloc(2);
	length.writeUInt16BE(payload.length + 2);
	return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

function sof(width: number, height: number, marker = 0xc0): Buffer {
	const payload = Buffer.alloc(9);
	payload[0] = 8; // sample precision
	payload.writeUInt16BE(height, 1);
	payload.writeUInt16BE(width, 3);
	payload[5] = 1; // component count
	return segment(marker, payload);
}

function jpeg(...parts: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts]);
}

describe("readImageDimensions — PNG structure", () => {
	it("reads width and height from a well-formed file", () => {
		expect(readImageDimensions(png(1200, 300), "image/png")).toEqual({
			width: 1200,
			height: 300,
		});
	});

	it("walks past ancillary chunks to the IEND", () => {
		const withExtras = png(
			640,
			480,
			chunk("gAMA", Buffer.alloc(4)),
			chunk("IDAT", Buffer.alloc(32)),
		);
		expect(readImageDimensions(withExtras, "image/png")).toEqual({
			width: 640,
			height: 480,
		});
	});

	// THE EXPLOIT. png-js reads chunk lengths with `|`, so >= 0x80000000 is
	// negative; its skip is `pos += chunkSize` bounded only by
	// `pos > data.length`, so a negative length walks backwards and the bound
	// never trips. This exact file hung the decoder's constructor forever, on a
	// public unauthenticated endpoint, while the old peek certified it as 1x1.
	it("rejects a chunk whose declared length has the high bit set", () => {
		const evil = Buffer.concat([
			PNG_SIGNATURE,
			chunk("IHDR", ihdrData(1, 1)),
			chunk("aaaa", Buffer.alloc(0), 0x80000000),
		]);
		expect(evil.length).toBeLessThan(64); // tiny — the byte caps see nothing
		expect(readImageDimensions(evil, "image/png")).toBeNull();
		expect(isDecodeSafe(evil, "image/png")).toBe(false);
	});

	// Which invariant actually rejects the file above: mutation testing showed it
	// is the IEND requirement, not the fits-inside-the-file check. Reading the
	// length UNSIGNED sends `pos` far past the end, the walk exits, and a file
	// that never reached IEND is refused. Worth stating, because the obvious
	// reading is wrong and the next person will assume the fit check did it.
	it("rejects a bogus-length chunk even when an IEND follows it", () => {
		const evilThenEnd = Buffer.concat([
			PNG_SIGNATURE,
			chunk("IHDR", ihdrData(1, 1)),
			chunk("aaaa", Buffer.alloc(0), 0x80000000),
			chunk("IEND"),
		]);
		expect(readImageDimensions(evilThenEnd, "image/png")).toBeNull();
	});

	// The fits-inside-the-file check earns its keep here: without it, these
	// offsets read past the end of the buffer and throw a RangeError out of the
	// upload handler instead of failing validation cleanly.
	it("returns null, not a thrown RangeError, on an IHDR truncated mid-field", () => {
		const truncated = Buffer.concat([
			PNG_SIGNATURE,
			Buffer.from([0x00, 0x00, 0x00, 0x0d]), // declares 13 bytes
			Buffer.from("IHDR", "ascii"),
			Buffer.alloc(6), // only 6 of them present
		]);
		expect(truncated.length).toBe(22);
		expect(() => readImageDimensions(truncated, "image/png")).not.toThrow();
		expect(readImageDimensions(truncated, "image/png")).toBeNull();
	});

	it("rejects any chunk that claims more bytes than the file holds", () => {
		const overrun = Buffer.concat([
			PNG_SIGNATURE,
			chunk("IHDR", ihdrData(1, 1)),
			chunk("IDAT", Buffer.alloc(8), 0x7fffffff),
		]);
		expect(readImageDimensions(overrun, "image/png")).toBeNull();
	});

	// png-js assigns width/height on EVERY IHDR, so a trailing one wins. We read
	// the first. Rather than pick a side, refuse the file: the two parsers would
	// disagree by construction.
	it("rejects a second IHDR, which the decoder would prefer over the first", () => {
		const twoHeaders = Buffer.concat([
			PNG_SIGNATURE,
			chunk("IHDR", ihdrData(1, 1)),
			chunk("IHDR", ihdrData(20000, 20000)),
			chunk("IEND"),
		]);
		expect(readImageDimensions(twoHeaders, "image/png")).toBeNull();
		expect(isDecodeSafe(twoHeaders, "image/png")).toBe(false);
	});

	it("requires the full 8-byte signature, not just the first four", () => {
		const short = png(64, 64);
		short[6] = 0x00; // corrupt byte 7 of the signature
		expect(readImageDimensions(short, "image/png")).toBeNull();
	});

	it("requires IHDR to come first and be exactly 13 bytes", () => {
		const wrongFirst = Buffer.concat([
			PNG_SIGNATURE,
			chunk("gAMA", Buffer.alloc(4)),
			chunk("IHDR", ihdrData(1, 1)),
			chunk("IEND"),
		]);
		expect(readImageDimensions(wrongFirst, "image/png")).toBeNull();

		const wrongLength = Buffer.concat([
			PNG_SIGNATURE,
			chunk("IHDR", Buffer.alloc(12)),
			chunk("IEND"),
		]);
		expect(readImageDimensions(wrongLength, "image/png")).toBeNull();
	});

	it("rejects a file that never reaches IEND", () => {
		const noEnd = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdrData(1, 1))]);
		expect(readImageDimensions(noEnd, "image/png")).toBeNull();
	});

	it("rejects zero dimensions", () => {
		expect(readImageDimensions(png(0, 64), "image/png")).toBeNull();
		expect(readImageDimensions(png(64, 0), "image/png")).toBeNull();
	});

	it("reads an over-cap size rather than clamping it — the cap is isDecodeSafe's job", () => {
		expect(readImageDimensions(png(8000, 8000), "image/png")).toEqual({
			width: 8000,
			height: 8000,
		});
	});
});

describe("readImageDimensions — JPEG", () => {
	it("reads a SOF0 that immediately follows the SOI", () => {
		expect(readImageDimensions(jpeg(sof(640, 480)), "image/jpeg")).toEqual({
			width: 640,
			height: 480,
		});
	});

	it("walks past earlier segments to reach the frame header", () => {
		const withPreamble = jpeg(
			segment(0xe0, Buffer.from("JFIF\0\0\0\0\0\0")),
			segment(0xfe, Buffer.from("a comment")),
			segment(0xdb, Buffer.alloc(65)),
			sof(1024, 768),
		);
		expect(readImageDimensions(withPreamble, "image/jpeg")).toEqual({
			width: 1024,
			height: 768,
		});
	});

	it("does not mistake DHT, JPG or DAC for a frame header", () => {
		for (const impostor of [0xc4, 0xc8, 0xcc]) {
			const buf = jpeg(segment(impostor, Buffer.alloc(20, 0x7f)), sof(50, 25));
			expect(readImageDimensions(buf, "image/jpeg")).toEqual({
				width: 50,
				height: 25,
			});
		}
	});

	it("reads the other SOF variants (progressive, arithmetic)", () => {
		for (const marker of [0xc1, 0xc2, 0xc9, 0xcf]) {
			expect(
				readImageDimensions(jpeg(sof(111, 222, marker)), "image/jpeg"),
			).toEqual({ width: 111, height: 222 });
		}
	});

	// The decoder react-pdf uses (`jay-peg`) gives every marker in 0xFFC0-0xFFFE
	// a length field and does not collapse 0xFF fill runs. Both shapes below are
	// legal JPEG, but we would read them differently than the decoder does, so
	// they are refused at upload rather than accepted and rendered as nothing.
	it("rejects fill bytes, which the decoder does not handle either", () => {
		const padded = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0xff, 0xff, 0xff]),
			sof(800, 600),
		]);
		expect(readImageDimensions(padded, "image/jpeg")).toBeNull();
	});

	it("rejects a segment claiming more bytes than the file holds", () => {
		const overrun = Buffer.concat([
			Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff]),
			Buffer.alloc(10),
		]);
		expect(readImageDimensions(overrun, "image/jpeg")).toBeNull();
	});

	it("rejects a zero-length segment instead of looping forever", () => {
		const bad = Buffer.concat([
			Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
			Buffer.alloc(40),
		]);
		expect(readImageDimensions(bad, "image/jpeg")).toBeNull();
	});

	it("rejects a missing SOI, a stray non-marker, and a truncated frame", () => {
		expect(readImageDimensions(Buffer.alloc(40), "image/jpeg")).toBeNull();
		expect(
			readImageDimensions(
				Buffer.concat([
					Buffer.from([0xff, 0xd8, 0x42, 0x43]),
					Buffer.alloc(40),
				]),
				"image/jpeg",
			),
		).toBeNull();
		expect(
			readImageDimensions(
				Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08]),
				"image/jpeg",
			),
		).toBeNull();
	});

	it("rejects a file with no frame header at all", () => {
		expect(
			readImageDimensions(jpeg(segment(0xe0, Buffer.alloc(10))), "image/jpeg"),
		).toBeNull();
	});

	it("rejects zero dimensions", () => {
		expect(readImageDimensions(jpeg(sof(0, 480)), "image/jpeg")).toBeNull();
	});
});

describe("isDecodeSafe", () => {
	it("accepts an image inside the cap on both axes", () => {
		expect(isDecodeSafe(png(2000, 2000), "image/png")).toBe(true);
	});

	it("rejects an image over the cap on either axis", () => {
		expect(isDecodeSafe(png(2001, 10), "image/png")).toBe(false);
		expect(isDecodeSafe(png(10, 2001), "image/png")).toBe(false);
	});

	it("rejects a mime outside the allow-list, whatever the bytes say", () => {
		expect(isDecodeSafe(png(64, 64), "image/svg+xml")).toBe(false);
		expect(isDecodeSafe(png(64, 64), "image/gif")).toBe(false);
	});

	it("rejects bytes whose structure cannot be validated", () => {
		expect(isDecodeSafe(Buffer.alloc(64, 0), "image/png")).toBe(false);
	});
});
