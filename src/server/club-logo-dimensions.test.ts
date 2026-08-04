/**
 * Unit tests for the image-header parsers behind the pixel-dimension cap (#496).
 *
 * These are pure functions, but until now they were only reachable through the
 * DB-gated integration suite — which SKIPS entirely without `TEST_DATABASE_URL`,
 * so on a plain `bun run test` nothing exercised them at all. That gap is not
 * theoretical: the JPEG walker rejected valid files with fill bytes, and the
 * integration fixtures could not see it because they place SOF0 immediately
 * after SOI, which is the one layout that needs no walking.
 *
 * `#/db` is stubbed rather than pointed at a test database: nothing here touches
 * it, and the stub keeps these runnable in the default suite.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { isDecodeSafe, readImageDimensions } = await import(
	"#/server/club-logo-logic"
);

// ---------------------------------------------------------------------------
// Builders — real header bytes, not fixtures with a magic prefix and zero fill.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(
	width: number,
	height: number,
	opts: { chunkType?: string; size?: number } = {},
): Buffer {
	// Always build at full size, then truncate — a caller asking for a short
	// buffer wants a TRUNCATED png, not a write past the end of a small one.
	const buf = Buffer.alloc(64, 0);
	buf.set(PNG_SIGNATURE, 0);
	buf.writeUInt32BE(13, 8); // IHDR payload length
	buf.write(opts.chunkType ?? "IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return opts.size === undefined ? buf : buf.subarray(0, opts.size);
}

/** A marker segment: 0xFF, marker, 2-byte self-inclusive length, payload. */
function segment(marker: number, payload: Buffer): Buffer {
	const length = Buffer.alloc(2);
	length.writeUInt16BE(payload.length + 2);
	return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

/** A start-of-frame: precision(1), height(2), width(2), then component data. */
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

describe("readImageDimensions — PNG", () => {
	it("reads width and height from the IHDR chunk", () => {
		expect(readImageDimensions(png(1200, 300), "image/png")).toEqual({
			width: 1200,
			height: 300,
		});
	});

	it("returns null when the buffer is too short to hold an IHDR", () => {
		expect(
			readImageDimensions(png(64, 64, { size: 20 }), "image/png"),
		).toBeNull();
	});

	it("returns null when the first chunk is not IHDR", () => {
		// The spec requires IHDR first; anything else means we cannot trust the
		// offsets, so we must not guess.
		expect(
			readImageDimensions(png(64, 64, { chunkType: "gAMA" }), "image/png"),
		).toBeNull();
	});

	it("returns null on zero dimensions", () => {
		expect(readImageDimensions(png(0, 64), "image/png")).toBeNull();
		expect(readImageDimensions(png(64, 0), "image/png")).toBeNull();
	});

	it("reads a dimension at the cap and one over it (the parser does not clamp)", () => {
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
		// The realistic layout: JFIF APP0, a comment, a quantisation table, then
		// the frame. The integration fixtures never exercised this.
		const withPreamble = jpeg(
			segment(0xe0, Buffer.from("JFIF\0\0\0\0\0\0")),
			segment(0xfe, Buffer.from("a comment")),
			segment(0xdb, Buffer.alloc(65)),
			sof(1024, 768),
		);
		expect(readImageDimensions(withPreamble, "image/jpeg")).toEqual({
			width: 1024,
			height: 768,
		});
	});

	it("tolerates 0xFF fill bytes before a marker", () => {
		// Legal JPEG. Assuming exactly one 0xFF read the second one as the marker,
		// then read entropy data as a segment length and desynchronised — so a
		// valid file was rejected as "not a valid PNG or JPEG image".
		const padded = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0xff, 0xff, 0xff]), // fill
			sof(800, 600),
		]);
		expect(readImageDimensions(padded, "image/jpeg")).toEqual({
			width: 800,
			height: 600,
		});
	});

	it("skips standalone markers, which carry no length field", () => {
		const withStandalone = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0xff, 0xd0]), // RST0 — no length
			Buffer.from([0xff, 0x01]), // TEM — no length
			sof(320, 240),
		]);
		expect(readImageDimensions(withStandalone, "image/jpeg")).toEqual({
			width: 320,
			height: 240,
		});
	});

	it("does not mistake DHT, JPG or DAC for a frame header", () => {
		// All three sit inside 0xC0-0xCF but are not frames. Treating one as a
		// frame would read table bytes as the image size.
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

	it("returns null on a zero-length segment instead of looping forever", () => {
		const bad = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0xff, 0xe0, 0x00, 0x00]), // length 0 — cannot advance
			Buffer.alloc(40),
		]);
		expect(readImageDimensions(bad, "image/jpeg")).toBeNull();
	});

	it("returns null when a marker position does not start with 0xFF", () => {
		const bad = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0x42, 0x43, 0x00, 0x04]),
			Buffer.alloc(40),
		]);
		expect(readImageDimensions(bad, "image/jpeg")).toBeNull();
	});

	it("returns null when the frame header is truncated", () => {
		const truncated = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08]), // stops mid-frame
		]);
		expect(readImageDimensions(truncated, "image/jpeg")).toBeNull();
	});

	it("returns null when no frame header is ever reached", () => {
		expect(
			readImageDimensions(jpeg(segment(0xe0, Buffer.alloc(10))), "image/jpeg"),
		).toBeNull();
	});

	it("returns null on zero dimensions", () => {
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
		// The stored row's mime is what gets echoed into the data URI, so a type
		// we never validated must not reach a decoder even if the header parses.
		expect(isDecodeSafe(png(64, 64), "image/svg+xml")).toBe(false);
		expect(isDecodeSafe(png(64, 64), "image/gif")).toBe(false);
	});

	it("rejects bytes whose header cannot be parsed", () => {
		expect(isDecodeSafe(Buffer.alloc(64, 0), "image/png")).toBe(false);
	});
});
