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
async function storedPixelSize(blob: Blob): Promise<ImageDimensions | null> {
	try {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		return readImageDimensions(bytes, blob.type);
	} catch {
		return null;
	}
}

/**
 * The size the browser's own decoder reports. Fallback only.
 *
 * Kept because this function is best-effort and the header parser is strict:
 * it refuses a structure it cannot prove the decoder reads the same way, and a
 * row uploaded under an older, looser version of that parser can still be
 * sitting in `club_logos`. Losing the crest on those decks would be a worse
 * regression than the one #518 fixes.
 *
 * It must NOT be the primary, because it answers a different question.
 * `createImageBitmap` APPLIES EXIF orientation, so for a phone-camera JPEG
 * carrying an orientation above 4 it returns the width and height SWAPPED
 * relative to the stored pixels — and `renderSplash`'s contain math then
 * derives its scale from the wrong pair, laying a 3:1 wordmark out as 1:3 in
 * the downloaded file while the projected deck (CSS `object-fit: contain` on
 * an `<img>`) stays correct. A square crest is the one shape a transpose
 * cannot hurt, which is why #513 never saw this.
 *
 * There is no option that turns that off, which is the trap: MDN documents
 * `{ imageOrientation: "none" }` as "ignore the metadata", but no shipping
 * engine implements those semantics — caniuse reports Chrome unsupported
 * across 4-155, and measured directly against a JPEG carrying EXIF
 * orientation 6, Chrome 149 returns 40x120 for a 120x40 image under BOTH the
 * default and `"none"`. Passing it would have looked like a fix and changed
 * nothing.
 */
async function decodedPixelSize(blob: Blob): Promise<ImageDimensions | null> {
	// No measurement, no logo: a stretched crest is worse than none, and
	// every supported browser has this.
	if (typeof createImageBitmap !== "function") return null;
	const bitmap = await createImageBitmap(blob);
	const { width, height } = bitmap;
	bitmap.close();
	if (!width || !height) return null;
	return { width, height };
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
 * already displays, and that response is `immutable, max-age=31536000`, so it
 * is normally warm in the HTTP cache. Note it is NOT served from the service
 * worker's asset cache — `isCacheableAsset` keys on `request.destination`, and
 * a `fetch()` has an empty destination, so the SW never handles this request
 * even though the `<img>` on the same page populated its cache.
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
		// Header first, decoder second — the order is the fix for #518, not a
		// preference. See `storedPixelSize` / `decodedPixelSize`.
		const size =
			(await storedPixelSize(blob)) ?? (await decodedPixelSize(blob));
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
