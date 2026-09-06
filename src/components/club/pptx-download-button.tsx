import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";
// Type-only: erased at compile time, so this does NOT pull deck-to-pptx (or
// pptxgenjs) into the main chunk — it stays behind the dynamic import below.
import type { ClubLogoAsset } from "#/lib/deck-to-pptx";
// Safe in the client bundle by construction — that module imports nothing, and
// `club-settings.tsx` already runs it in the browser for the upload pre-check.
import {
	type ImageDimensions,
	readImageDimensions,
} from "#/lib/image-dimensions";

/**
 * How long to wait for the logo before exporting without it. The deck is the
 * deliverable; the logo is decoration, and `finally { setBusy(false) }` only
 * runs once this settles — an unbounded fetch that never resolves would leave
 * the button spinning and permanently disabled, with no way back short of a
 * page reload.
 */
export const LOGO_FETCH_TIMEOUT_MS = 5_000;

/** Read a blob as a data URI. Never rejects; resolves null on reader error. */
function blobToDataUri(blob: Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onloadend = () =>
			resolve(typeof reader.result === "string" ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(blob);
	});
}

/** The blob's bytes, or null. Read ONCE — both measurements below want them. */
async function blobBytes(blob: Blob): Promise<Uint8Array | null> {
	try {
		return new Uint8Array(await blob.arrayBuffer());
	} catch {
		return null;
	}
}

/**
 * The size of the image AS STORED, read from the file header (#518).
 *
 * This is the authority for the .pptx, and the axis order is the whole point.
 * pptxgenjs embeds the bytes verbatim and PowerPoint draws them WITHOUT
 * applying EXIF orientation, so the only size that describes what the deck
 * will actually show is the one the frame header declares — which is exactly
 * what `readImageDimensions` reports, because it walks to the SOF marker and
 * never looks at the APP1/EXIF block.
 *
 * Sharing the parser with `club-logo-logic.ts`'s upload gate and
 * `club-settings.tsx`'s pre-check is a bonus that #504 already argued for at
 * length: three call sites, one implementation, so they cannot disagree about
 * the same file with every gate green. Rotated JPEGs are where they used to.
 *
 * Null (not a throw) for anything it will not vouch for — the caller falls
 * back to the decoder below rather than dropping the logo.
 */
function storedPixelSize(
	bytes: Uint8Array | null,
	mime: string,
): ImageDimensions | null {
	return bytes ? readImageDimensions(bytes, mime) : null;
}

/** The EXIF orientations that transpose the axes — the four quarter turns. */
const TRANSPOSING_ORIENTATIONS = new Set([5, 6, 7, 8]);

/** "Exif\0\0" — the preamble an orientation-bearing APP1 payload opens with. */
const EXIF_PREAMBLE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/**
 * The EXIF Orientation a JPEG declares, or null if it declares none.
 *
 * Deliberately LOOSER than `readImageDimensions`, and that is the entire
 * reason it exists rather than being folded into it. That parser refuses any
 * structure it cannot prove the react-pdf decoders read identically — it will
 * not collapse a `0xFF` fill run, by an explicit decision documented on
 * `readJpegDimensions`. This runs on exactly the files it refused, so
 * inheriting its strictness would make it decline the same ones and answer
 * null precisely when the answer matters. Tolerating fill runs and standalone
 * markers is what a shipping decoder does, and matching the DECODER is the job
 * here: the number being corrected came from one.
 *
 * Total — never throws, null for anything malformed. A logo the browser could
 * decode but this cannot read is simply left at the decoder's numbers.
 */
function exifOrientation(bytes: Uint8Array): number | null {
	try {
		if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // not a JPEG
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let pos = 2;
		while (pos + 4 <= bytes.length) {
			if (bytes[pos] !== 0xff) return null;
			// Fill bytes: any run of 0xFF may pad the gap before a marker.
			if (bytes[pos + 1] === 0xff) {
				pos++;
				continue;
			}
			const marker = bytes[pos + 1];
			// From the scan onward a 0xFF is entropy-coded payload, not a marker,
			// and EXIF lives in the header — nothing left to find either way.
			if (marker === 0xda || marker === 0xd9) return null;
			// TEM and RST0-7 stand alone: no length field to advance by.
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				pos += 2;
				continue;
			}
			const length = view.getUint16(pos + 2);
			if (length < 2 || pos + 2 + length > bytes.length) return null;
			if (marker === 0xe1) {
				return app1Orientation(view, pos + 4, pos + 2 + length);
			}
			pos += 2 + length;
		}
		return null;
	} catch {
		return null;
	}
}

/** Orientation out of one APP1 payload spanning `[start, end)`. */
function app1Orientation(
	view: DataView,
	start: number,
	end: number,
): number | null {
	for (let i = 0; i < EXIF_PREAMBLE.length; i++) {
		if (start + i >= end) return null;
		if (view.getUint8(start + i) !== EXIF_PREAMBLE[i]) return null;
	}
	const tiff = start + EXIF_PREAMBLE.length;
	if (tiff + 8 > end) return null;
	const order = view.getUint16(tiff);
	if (order !== 0x4d4d && order !== 0x4949) return null; // "MM" / "II"
	const le = order === 0x4949;
	if (view.getUint16(tiff + 2, le) !== 42) return null; // TIFF magic
	const ifd = tiff + view.getUint32(tiff + 4, le);
	if (ifd < tiff || ifd + 2 > end) return null;
	const entries = view.getUint16(ifd, le);
	for (let i = 0; i < entries; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > end) return null;
		if (view.getUint16(entry, le) !== 0x0112) continue; // not Orientation
		if (view.getUint16(entry + 2, le) !== 3) return null; // must be a SHORT
		return view.getUint16(entry + 8, le); // left-aligned in the value field
	}
	return null;
}

/**
 * The size the browser's own decoder reports, corrected back onto the stored
 * axes. Fallback only.
 *
 * Kept because this function is best-effort and the header parser is strict:
 * it refuses a structure it cannot prove the decoder reads the same way, and
 * that window is real rather than theoretical. Club logos shipped at v1.4.0.0
 * (#505) with magic-byte and MIME validation and NO structural parse;
 * `readImageDimensions` only reached the upload path at v1.5.0.0 (#496/#513).
 * Every row uploaded in between went into `club_logos` unparsed, so a legal
 * JPEG that parser declines — a `0xFF` fill run before a segment is enough —
 * can still be sitting there. Losing the crest on those decks would be a worse
 * regression than the one #518 fixes.
 *
 * But arriving here must not silently reinstate the bug, which is what the
 * first cut of this fix did. `createImageBitmap` APPLIES EXIF orientation, so
 * for a phone-camera JPEG carrying an orientation above 4 it returns width and
 * height SWAPPED relative to the stored pixels — and `renderSplash`'s contain
 * math then derives its scale from the wrong pair, laying a 3:1 wordmark out
 * as 1:3 in the downloaded file while the projected deck (CSS
 * `object-fit: contain` on an `<img>`) stays correct. A square crest is the
 * one shape a transpose cannot hurt, which is why #513 never saw this. So the
 * rotation the decoder applied is read back off the bytes and undone, and this
 * path answers the same question the header parser does.
 *
 * There is no option that avoids the rotation, which is the trap: MDN
 * documents `{ imageOrientation: "none" }` as "ignore the metadata", but no
 * shipping engine implements those semantics — caniuse reports Chrome
 * unsupported across 4-155, and measured directly against a JPEG carrying EXIF
 * orientation 6, Chrome 149 returns 40x120 for a 120x40 image under BOTH the
 * default and `"none"` (independently reproduced on Chromium 151). Passing it
 * would have looked like a fix and changed nothing.
 */
async function decodedPixelSize(
	blob: Blob,
	bytes: Uint8Array | null,
): Promise<ImageDimensions | null> {
	// No measurement, no logo: a stretched crest is worse than none, and
	// every supported browser has this.
	if (typeof createImageBitmap !== "function") return null;
	const bitmap = await createImageBitmap(blob);
	const { width, height } = bitmap;
	bitmap.close();
	if (!width || !height) return null;
	const orientation = bytes ? exifOrientation(bytes) : null;
	return orientation !== null && TRANSPOSING_ORIENTATIONS.has(orientation)
		? { width: height, height: width }
		: { width, height };
}

/**
 * Fetch the club's logo, measure it, and encode it for pptxgenjs — or null.
 *
 * Deliberately best-effort: a missing, slow or failed logo must never cost
 * someone their deck, so every failure path returns null and the export
 * proceeds without an image.
 *
 * The intrinsic pixel size is read here rather than left to pptxgenjs because
 * pptxgenjs cannot preserve aspect ratio on its own — see the contain math in
 * `deck-to-pptx.ts`'s `renderSplash`. It comes from the file HEADER
 * (`storedPixelSize`) rather than from a decode, so it describes the same
 * bytes that get embedded; see there for why the decoder is the fallback and
 * not the other way round.
 *
 * On offline behaviour: this reads the same public URL the projected deck
 * already displays, which answers a bounded `max-age` (`LOGO_MAX_AGE_SECONDS`)
 * with `must-revalidate` and an ETag, so a second export in a sitting is
 * normally a cache hit and a stale one revalidates cheaply. Deliberately NOT
 * `immutable` any more (#517): that disabled #556's eviction, because the
 * service worker revalidates with a plain `fetch` the browser's own HTTP cache
 * satisfied, so `response.ok` stayed true and an archived club's crest could
 * never be evicted. See `CODING_STANDARDS.md`. Note it is NOT served from the
 * service worker's asset cache either — `isCacheableAsset` keys on
 * `request.destination`, and a `fetch()` has an empty destination, so the SW
 * never handles this request even though the `<img>` on the same page
 * populated its cache.
 */
export async function fetchClubLogo(
	logoUrl: string | null,
): Promise<ClubLogoAsset | null> {
	if (!logoUrl) return null;
	const url = logoUrl; // narrowed once, so the nested helper keeps the type
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The deadline covers the WHOLE operation, not just the network call. The
	// signal only aborts `fetch`; the measurement and `FileReader` run after it
	// and are bounded by nothing, so a decode that never settles would leave
	// the caller's `finally { setBusy(false) }` unreached and the button stuck —
	// exactly the failure the timeout exists to prevent.
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(null);
		}, LOGO_FETCH_TIMEOUT_MS);
	});
	try {
		return await Promise.race([deadline, measure()]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}

	async function measure(): Promise<ClubLogoAsset | null> {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return null;
		const blob = await res.blob();
		const bytes = await blobBytes(blob);
		// Header first, decoder second — the order is the fix for #518, not a
		// preference. Both answer in STORED axes, so the fallback is a degraded
		// source, not a different convention. See `storedPixelSize` /
		// `decodedPixelSize`.
		const size =
			storedPixelSize(bytes, blob.type) ??
			(await decodedPixelSize(blob, bytes));
		if (!size) return null;
		const dataUri = await blobToDataUri(blob);
		return dataUri ? { dataUri, ...size } : null;
	}
}

/**
 * Downloads the present-mode deck as an editable `.pptx`. Same ungated
 * visibility as Present/Print. Generation happens entirely client-side (see
 * `deck-to-pptx.ts`).
 *
 * Extracted from the button so the meeting toolbar's export menu (#541) can
 * invoke it too. Returns after the file is written or the failure toast is
 * shown — callers only manage their own busy state.
 *
 * Re-entrant — nothing is shared between calls; a double invoke just
 * downloads twice, so a caller's busy flag is for UI, not correctness.
 */
export async function downloadDeckPptx({
	deck,
	clubName,
}: {
	deck: Slide[];
	clubName: string;
}): Promise<void> {
	try {
		const title = deck.find((s) => s.kind === "title");
		// Dynamic import keeps pptxgenjs + the builder off the main chunk; the
		// logo fetch is independent, so both go out at once rather than the
		// ~1 MB library download gating a network round trip.
		const [[{ default: PptxGenJS }, { deckToPptx, pptxFileName }], logo] =
			await Promise.all([
				Promise.all([import("pptxgenjs"), import("#/lib/deck-to-pptx")]),
				fetchClubLogo(title?.logoUrl ?? null),
			]);
		const fileName = title
			? pptxFileName(clubName, title.scheduledAt, title.timezone)
			: `${clubName} Agenda.pptx`;
		const pptx = deckToPptx(PptxGenJS, deck, logo);
		await pptx.writeFile({ fileName });
	} catch (err) {
		console.error("pptx export failed", err);
		toast.error("Could not build the PowerPoint file.");
	}
}

export function PptxDownloadButton({
	deck,
	clubName,
	variant = "outline",
	size = "sm",
}: {
	deck: Slide[];
	clubName: string;
	variant?: "outline" | "secondary" | "ghost";
	size?: "sm" | "default";
}) {
	const [busy, setBusy] = useState(false);

	async function download() {
		if (busy) return;
		setBusy(true);
		try {
			await downloadDeckPptx({ deck, clubName });
		} finally {
			setBusy(false);
		}
	}

	return (
		<Button
			type="button"
			variant={variant}
			size={size}
			onClick={download}
			disabled={busy}
		>
			{busy ? <Loader2 className="animate-spin" /> : <Download />}
			Download .pptx
		</Button>
	);
}
