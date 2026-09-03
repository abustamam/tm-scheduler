/**
 * Intrinsic pixel size of a PNG or JPEG, read from the file's HEADER STRUCTURE
 * without decoding it (#496, moved here by #504).
 *
 * ## Why this is in `lib/` and not beside its server caller
 *
 * Two consumers need the same answer and one of them is a browser:
 *
 *   · `club-logo-logic.ts` gates uploads and the public role-sheet PDF render.
 *   · `club-settings.tsx` pre-checks the admin's pick before the round-trip.
 *
 * The client half used `createImageBitmap` until #504, which is the browser's
 * full decoder. That made the pre-check cost what the cap exists to prevent:
 * measured in headless Chrome, the 8000x8000 mostly-transparent PNG this
 * module's cap was written for weighs 243.1 KiB — inside the byte cap, so it
 * REACHES the check — and decoding it cost 52.9 ms and 244 MB of renderer RSS,
 * purely to learn two numbers and reject the file. Parsing the header instead
 * costs 0.1-0.3 ms and allocates nothing, on any input size.
 *
 * The bigger win is not speed. A browser decoder and this parser are different
 * implementations, so they could disagree about the same file with every gate
 * green — the client accepting what the server refuses, or the reverse. Sharing
 * ONE function makes them agree by construction, which is the same argument
 * `#/lib/club-logo-limits` makes about the numbers. It also makes the client
 * check testable in jsdom with real bytes, where a `createImageBitmap` stub was
 * the only option before.
 *
 * `Uint8Array`, not `Buffer`: this file imports nothing, so it is safe in the
 * client bundle. Node's `Buffer` IS a `Uint8Array`, so server callers pass
 * their buffers unchanged.
 *
 * ## What "reads the header" means here — read before editing
 *
 * Establishing the size by STRUCTURALLY VALIDATING the file, not by peeking at
 * fixed offsets. The distinction is the whole point, and getting it wrong
 * shipped a worse bug than the one the cap was added to fix. The first version
 * read bytes 16-24 of a PNG and returned them. That is not validation: the
 * decoder that actually runs is `png-js` (reached via `@react-pdf/image`, which
 * dispatches on the DECLARED mime and never sniffs), and it walks the whole
 * chunk list with three behaviours a fixed-offset peek cannot see:
 *
 *   · `readUInt32` composes with `|`, so a declared chunk length >= 0x80000000
 *     is NEGATIVE. Its skip is `pos += chunkSize` and its only bound is
 *     `if (pos > data.length) throw`, so a negative length walks `pos` BACKWARDS
 *     and the bound never trips. A 45-byte file built this way makes the
 *     constructor loop forever — synchronously, on a public unauthenticated
 *     endpoint, in a single-process server. Verified: it never returns.
 *   · `case 'IDAT'` copies `chunkSize` bytes one push at a time BEFORE that
 *     bound is checked.
 *   · `case 'IHDR'` assigns width/height on EVERY IHDR chunk, so a trailing
 *     second IHDR wins. The old peek read the first and certified 1x1 for a file
 *     the decoder saw as 20000x20000.
 *
 * So the rule enforced here is not "find the dimensions" but "prove the
 * structure is one the decoder will read the same way we did". Every chunk
 * length is read UNSIGNED and must fit inside the file. That single invariant
 * removes the negative-length class entirely: a length that fits in a <=256 KB
 * upload is necessarily far below 0x80000000, so `png-js`'s signed read and ours
 * cannot disagree.
 *
 * Returns null whenever the structure is anything other than plainly sound.
 * Callers treat null as rejection: a file we cannot parse confidently is exactly
 * the file not to hand to a decoder. The one caller that treats null as "don't
 * block" is the CLIENT pre-check, deliberately — it is a shortcut to the error
 * message, never the gate, and the server re-runs this same function.
 *
 * Because the walk must reach IEND, a caller cannot hand this a truncated
 * PREFIX of a file and expect an answer: a 64 KB slice of a 243 KB PNG returns
 * null, correctly. Give it the whole file. That is affordable precisely because
 * the byte cap is checked first.
 */

export type ImageDimensions = { width: number; height: number };

/** PNG's full 8-byte signature. `matchesMagicBytes` checks only the first four,
 *  which is looser than every real decoder. */
const PNG_SIGNATURE_FULL = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A `DataView` over exactly this array's bytes.
 *
 * `byteOffset`/`byteLength` are passed explicitly and are not optional: Node
 * pools small `Buffer`s inside a shared `ArrayBuffer`, so `new DataView(b.buffer)`
 * silently reads a window starting at somebody else's data.
 */
const viewOf = (bytes: Uint8Array) =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The 4-byte ASCII chunk type at `pos`, e.g. "IHDR". */
function chunkTypeAt(bytes: Uint8Array, pos: number): string {
	return String.fromCharCode(
		bytes[pos],
		bytes[pos + 1],
		bytes[pos + 2],
		bytes[pos + 3],
	);
}

export function readImageDimensions(
	bytes: Uint8Array,
	mime: string,
): ImageDimensions | null {
	if (mime === "image/png") return readPngDimensions(bytes);
	if (mime === "image/jpeg") return readJpegDimensions(bytes);
	return null;
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < PNG_SIGNATURE_FULL.length) return null;
	for (let i = 0; i < PNG_SIGNATURE_FULL.length; i++) {
		if (bytes[i] !== PNG_SIGNATURE_FULL[i]) return null;
	}

	const view = viewOf(bytes);
	let pos = 8;
	let dimensions: ImageDimensions | null = null;

	// Chunk: length(4) + type(4) + data(length) + crc(4).
	while (pos + 8 <= bytes.length) {
		const length = view.getUint32(pos); // UNSIGNED — see the doc comment
		const type = chunkTypeAt(bytes, pos + 4);
		const next = pos + 8 + length + 4;
		// Every chunk must fit. This is the invariant that makes our read and the
		// decoder's agree, so it must reject rather than clamp.
		if (next > bytes.length) return null;

		if (dimensions === null) {
			// The spec requires IHDR first, and exactly 13 bytes of it.
			if (type !== "IHDR" || length !== 13) return null;
			const width = view.getUint32(pos + 8);
			const height = view.getUint32(pos + 12);
			if (width === 0 || height === 0) return null;
			dimensions = { width, height };
		} else if (type === "IHDR") {
			// A second IHDR: the decoder would keep THIS one while we returned the
			// first, so the two would disagree by construction. Refuse.
			return null;
		}

		if (type === "IEND") return dimensions;
		pos = next;
	}
	// Ran off the end without an IEND.
	return null;
}

/**
 * JPEG frame size, walked under the SAME rule the decoder uses.
 *
 * react-pdf decodes JPEG with `jay-peg`, whose marker table assigns a length
 * field to every marker in 0xFFC0-0xFFFE. An earlier version of this walker
 * special-cased RST/TEM as standalone and collapsed 0xFF fill runs; both are
 * legal JPEG, but `jay-peg` does neither, so the two parsers could land on
 * different frame headers and the cap would be measuring an image nobody
 * decodes. Matching the decoder matters more than accepting every legal file:
 * a shape we read differently is rejected at upload with a clear message rather
 * than accepted and rendered as nothing.
 */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 4) return null;
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI

	const view = viewOf(bytes);
	let pos = 2;
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) return null;
		const marker = bytes[pos + 1];
		if (marker === 0xd9) return null; // EOI before any frame
		const segmentLength = view.getUint16(pos + 2);
		// The length counts itself, so under 2 cannot advance.
		if (segmentLength < 2) return null;
		if (pos + 2 + segmentLength > bytes.length) return null;

		// SOF0-SOF15 carry the frame size. DHT (0xc4), JPG (0xc8) and DAC (0xcc)
		// share the range but are not frame headers.
		const isFrameHeader =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isFrameHeader) {
			// length(2), precision(1), height(2), width(2)
			if (segmentLength < 7) return null;
			const height = view.getUint16(pos + 5);
			const width = view.getUint16(pos + 7);
			if (width === 0 || height === 0) return null;
			return { width, height };
		}
		pos += 2 + segmentLength;
	}
	return null;
}
