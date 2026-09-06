// @vitest-environment jsdom
/**
 * `fetchClubLogo` measures the logo AS STORED, not as a decoder would show it
 * (#518).
 *
 * ## The bug
 *
 * `fetchClubLogo` used to size the crest with `createImageBitmap`, which
 * APPLIES EXIF orientation. pptxgenjs embeds the bytes verbatim and PowerPoint
 * draws them without applying it, so for a JPEG carrying an orientation above
 * 4 — a phone-camera photo, the most likely way a club produces one — the two
 * disagreed by a transpose: `renderSplash` computed
 * `Math.min(BOX_W / width, BOX_H / height)` from a swapped pair and drew the
 * image at the inverse of its real aspect. Same family as the inverted-aspect
 * smear #513 fixed, reaching the one input class that fix could not see — a
 * square crest is the single shape a transpose cannot hurt, and a square crest
 * is what #513 was written against. The projected deck and the four print
 * surfaces were unaffected: they use CSS
 * `object-fit: contain` on an `<img>`, where the browser applies orientation
 * and the layout follows it.
 *
 * ## Why the fixture is real EXIF and the decoder is a model
 *
 * A stub told to return a swapped pair would prove the arithmetic and nothing
 * about orientation. So the fixture below is a JPEG carrying a real APP1/EXIF
 * block with `Orientation = 6`, and the stub is not told what to return: it
 * PARSES that block out of the bytes it is handed and transposes only if it
 * finds an orientation in 5-8, exactly as an engine does. Build the fixture
 * wrong and `exifOrientationOf` reports nothing, the stub stops transposing,
 * and the "reproduces the bug" control below fails rather than the suite
 * passing vacuously. The parser under test has to walk PAST that same APP1
 * block to reach the frame header, so the bytes are load-bearing on both sides.
 *
 * The model is faithful to a measurement, not to the spec. Driven against a
 * Chrome-encoded 120x40 JPEG with this exact APP1 block spliced in, headless
 * Chrome 149 reported `40x120` for `createImageBitmap(blob)`, for
 * `{ imageOrientation: "from-image" }` AND for `{ imageOrientation: "none" }`.
 * That last one is the trap: #518 proposed it as the fix, and MDN does document
 * `"none"` as "ignore the metadata" — but no engine ships those semantics
 * (caniuse has Chrome unsupported across 4-155), so passing it would have
 * looked like a fix and changed nothing. Hence the stub ignores its options
 * argument: it models the browsers that exist, not the one in the docs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ImageDimensions,
	readImageDimensions,
} from "#/lib/image-dimensions";
import { fetchClubLogo } from "./pptx-download-button";

const URL_ = "/api/club/abc/logo?v=1";

// ---------------------------------------------------------------------------
// Fixture: a JPEG whose frame header and EXIF block disagree on purpose.
// Built the way `image-dimensions.test.ts` builds its fixtures — same house
// style, and the same parser reads both.
// ---------------------------------------------------------------------------

function segment(marker: number, payload: Buffer): Buffer {
	const length = Buffer.alloc(2);
	length.writeUInt16BE(payload.length + 2);
	return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

/** An APP1 payload whose IFD0 holds exactly one entry: Orientation. */
function exifPayload(orientation: number): Buffer {
	const tiff = Buffer.alloc(26);
	tiff.write("MM", 0, "latin1"); // big-endian byte order
	tiff.writeUInt16BE(42, 2); // TIFF magic
	tiff.writeUInt32BE(8, 4); // IFD0 sits right after this header
	tiff.writeUInt16BE(1, 8); // entry count
	tiff.writeUInt16BE(0x0112, 10); // tag: Orientation
	tiff.writeUInt16BE(3, 12); // type: SHORT
	tiff.writeUInt32BE(1, 14); // value count
	tiff.writeUInt16BE(orientation, 18); // left-aligned in the 4-byte value field
	// Bytes 22-25 stay zero: no next IFD.
	return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
}

/** A baseline frame header — the STORED axes, the ones PowerPoint draws. */
function sof(width: number, height: number): Buffer {
	const payload = Buffer.alloc(9);
	payload[0] = 8; // sample precision
	payload.writeUInt16BE(height, 1);
	payload.writeUInt16BE(width, 3);
	payload[5] = 1; // component count
	return segment(0xc0, payload);
}

function jpeg({
	width,
	height,
	orientation,
	fillRun = false,
}: {
	width: number;
	height: number;
	/** Omit for a file carrying no EXIF block at all. */
	orientation?: number;
	/**
	 * Pad the gap before the first marker with a `0xFF` fill byte (T.81
	 * B.1.1.2). Legal JPEG that decoders accept, and that
	 * `readImageDimensions` refuses BY DESIGN — its `readJpegDimensions`
	 * comment says it will not collapse fill runs because `jay-peg`, the
	 * decoder react-pdf actually reaches for, does not either. That makes this
	 * flag the cheapest honest way to build a file which reaches the fallback.
	 */
	fillRun?: boolean;
}): Uint8Array<ArrayBuffer> {
	const fill = fillRun ? [Buffer.from([0xff])] : [];
	const exif =
		orientation === undefined ? [] : [segment(0xe1, exifPayload(orientation))];
	// Copied out of the Buffer: a pooled `Buffer` is a `Uint8Array<ArrayBufferLike>`,
	// which `BlobPart` does not accept.
	return Uint8Array.from(
		Buffer.concat([
			Buffer.from([0xff, 0xd8]), // SOI
			...fill,
			...exif,
			sof(width, height),
			Buffer.from([0xff, 0xd9]), // EOI
		]),
	);
}

// ---------------------------------------------------------------------------
// The browser model: an orientation-applying decoder, driven by the bytes.
// ---------------------------------------------------------------------------

/**
 * EXIF Orientation out of a JPEG's APP1 block, or null. Either byte order.
 *
 * Tolerates `0xFF` fill runs, as every shipping decoder does and as
 * `readImageDimensions` deliberately does not. That divergence is the point:
 * it is what lets a fixture be decodable and unparseable at once, which is the
 * exact class the production fallback exists for.
 */
function exifOrientationOf(bytes: Uint8Array): number | null {
	// byteOffset/byteLength are not optional — Node pools small Buffers inside a
	// shared ArrayBuffer, so a bare `new DataView(b.buffer)` reads someone
	// else's data. Same reason `image-dimensions.ts`'s `viewOf` passes them.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 2; // past SOI
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) return null;
		if (bytes[pos + 1] === 0xff) {
			pos++; // fill byte
			continue;
		}
		const marker = bytes[pos + 1];
		const length = view.getUint16(pos + 2);
		if (marker === 0xe1) {
			const tiff = pos + 4 + 6; // past the "Exif\0\0" preamble
			const le = view.getUint16(tiff) === 0x4949; // "II"
			const ifd = tiff + view.getUint32(tiff + 4, le);
			const entries = view.getUint16(ifd, le);
			for (let i = 0; i < entries; i++) {
				const entry = ifd + 2 + i * 12;
				if (view.getUint16(entry, le) === 0x0112) {
					return view.getUint16(entry + 8, le);
				}
			}
			return null;
		}
		pos += 2 + length;
	}
	return null;
}

/**
 * Install a `createImageBitmap` that behaves like a shipping engine: it reports
 * the size AFTER applying whatever orientation the bytes declare, and no option
 * turns that off (see the file header). Returns the recorded calls so a test
 * can assert the export never decoded at all.
 */
function stubBrowserDecoder(stored: ImageDimensions) {
	const calls: Blob[] = [];
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async (blob: Blob) => {
			calls.push(blob);
			const orientation = exifOrientationOf(
				new Uint8Array(await blob.arrayBuffer()),
			);
			const transposed = orientation !== null && orientation >= 5;
			return {
				width: transposed ? stored.height : stored.width,
				height: transposed ? stored.width : stored.height,
				close: vi.fn(),
			};
		}),
	);
	return calls;
}

function serve(bytes: Uint8Array<ArrayBuffer>, type = "image/jpeg") {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			blob: async () => new Blob([bytes], { type }),
		})),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("EXIF-rotated logos in the .pptx export (#518)", () => {
	/** 120x40 stored; EXIF says rotate 90° CW, so a decoder shows it 40x120. */
	const ROTATED = jpeg({ width: 120, height: 40, orientation: 6 });

	// The control the rest of the file rests on. If the fixture ever loses its
	// EXIF block, this fails here rather than making every assertion below free.
	it("reproduces the bug: a decoder reports this fixture transposed", async () => {
		expect(exifOrientationOf(ROTATED)).toBe(6);
		stubBrowserDecoder({ width: 120, height: 40 });

		const bitmap = await createImageBitmap(
			new Blob([ROTATED], { type: "image/jpeg" }),
		);

		expect([bitmap.width, bitmap.height]).toEqual([40, 120]);
	});

	it("reports the stored axes, not the ones a decoder would show", async () => {
		serve(ROTATED);
		stubBrowserDecoder({ width: 120, height: 40 });

		const logo = await fetchClubLogo(URL_);

		// 120x40 is what pptxgenjs embeds and PowerPoint draws. 40x120 is the old
		// answer, and it made `renderSplash` lay a 3:1 wordmark out as 1:3.
		expect(logo?.width).toBe(120);
		expect(logo?.height).toBe(40);
		expect(logo?.dataUri).toMatch(/^data:/);
	});

	it("does not decode the image at all when the header parses", async () => {
		serve(ROTATED);
		const calls = stubBrowserDecoder({ width: 120, height: 40 });

		await fetchClubLogo(URL_);

		// Not merely faster (#504 measured 52.9 ms and 244 MB of renderer RSS for
		// the 8000x8000 PNG the size cap exists for). A decode that never
		// influences the result is a second opinion waiting to be preferred back.
		expect(calls).toHaveLength(0);
	});

	it("leaves an unrotated JPEG's measurement unchanged", async () => {
		serve(jpeg({ width: 120, height: 40, orientation: 1 }));
		stubBrowserDecoder({ width: 120, height: 40 });

		const logo = await fetchClubLogo(URL_);

		expect([logo?.width, logo?.height]).toEqual([120, 40]);
	});

	it("measures a JPEG carrying no EXIF block at all", async () => {
		serve(jpeg({ width: 300, height: 300 }));
		stubBrowserDecoder({ width: 300, height: 300 });

		const logo = await fetchClubLogo(URL_);

		expect([logo?.width, logo?.height]).toEqual([300, 300]);
	});

	// -----------------------------------------------------------------------
	// The fallback. Club logos shipped at v1.4.0.0 (#505) with magic-byte and
	// MIME validation and no structural parse; `readImageDimensions` reached
	// the upload path at v1.5.0.0 (#496/#513). Rows uploaded in between went in
	// unparsed, so a legal JPEG the strict walker declines is really in
	// `club_logos` and really reaches this path.
	//
	// A four-byte fixture would not test it. No engine decodes that, so a real
	// `createImageBitmap` rejects and `fetchClubLogo` returns null through the
	// outer catch — it pins the wiring and is blind to the class. These use a
	// file that DECODES fine and only the strict parser refuses.
	// -----------------------------------------------------------------------

	/** Decodable, refused by `readImageDimensions`, and EXIF-rotated. */
	const FALLBACK_ROTATED = jpeg({
		width: 120,
		height: 40,
		orientation: 6,
		fillRun: true,
	});

	// The second control. If the strict parser is ever loosened to collapse fill
	// runs, this fixture stops reaching the fallback and the two tests below go
	// green without exercising anything — so assert the precondition here, where
	// it fails loudly and says why.
	it("reaches the fallback: decodable, unparseable, and rotated", () => {
		expect(readImageDimensions(FALLBACK_ROTATED, "image/jpeg")).toBeNull();
		expect(exifOrientationOf(FALLBACK_ROTATED)).toBe(6);
	});

	it("undoes the decoder's rotation on the fallback path", async () => {
		serve(FALLBACK_ROTATED);
		stubBrowserDecoder({ width: 120, height: 40 });

		const logo = await fetchClubLogo(URL_);

		// Without the correction this is 40x120 — #518 verbatim, on the branch
		// that closes it, for every row uploaded before the parser existed.
		expect([logo?.width, logo?.height]).toEqual([120, 40]);
	});

	it("leaves the fallback alone when the file declares no rotation", async () => {
		serve(jpeg({ width: 64, height: 64, fillRun: true }));
		stubBrowserDecoder({ width: 64, height: 64 });

		const logo = await fetchClubLogo(URL_);

		expect([logo?.width, logo?.height]).toEqual([64, 64]);
	});

	it("still returns null when neither the header nor a decoder can measure", async () => {
		serve(FALLBACK_ROTATED);
		vi.stubGlobal("createImageBitmap", undefined);

		expect(await fetchClubLogo(URL_)).toBeNull();
	});
});
