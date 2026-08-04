import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";
// Type-only: erased at compile time, so this does NOT pull deck-to-pptx (or
// pptxgenjs) into the main chunk — it stays behind the dynamic import below.
import type { ClubLogoAsset } from "#/lib/deck-to-pptx";

/**
 * Downloads the present-mode deck as an editable `.pptx`. Same ungated
 * visibility as Present/Print. Generation happens entirely client-side and the
 * ~1 MB `pptxgenjs` library is dynamic-`import()`ed only on click, so it is
 * code-split out of the main bundle (see `deck-to-pptx.ts`).
 */
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
 * Fetch the club's logo, measure it, and encode it for pptxgenjs — or null.
 *
 * Deliberately best-effort: a missing, slow or failed logo must never cost
 * someone their deck, so every failure path returns null and the export
 * proceeds without an image.
 *
 * The intrinsic pixel size is read here rather than left to pptxgenjs because
 * pptxgenjs cannot preserve aspect ratio on its own — see the contain math in
 * `deck-to-pptx.ts`'s `renderSplash`.
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
	// signal only aborts `fetch`; `createImageBitmap` and `FileReader` run after
	// it and are bounded by nothing, so a decode that never settles would leave
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
		// No measurement, no logo: a stretched crest is worse than none, and
		// every supported browser has this.
		if (typeof createImageBitmap !== "function") return null;
		const bitmap = await createImageBitmap(blob);
		const { width, height } = bitmap;
		bitmap.close();
		if (!width || !height) return null;
		const dataUri = await blobToDataUri(blob);
		return dataUri ? { dataUri, width, height } : null;
	}
}

export function PptxDownloadButton({
	deck,
	clubName,
	logoUrl = null,
	variant = "outline",
	size = "sm",
}: {
	deck: Slide[];
	clubName: string;
	/** Versioned logo URL, or null. Fetched on click, never at render. */
	logoUrl?: string | null;
	variant?: "outline" | "secondary" | "ghost";
	size?: "sm" | "default";
}) {
	const [busy, setBusy] = useState(false);

	async function download() {
		if (busy) return;
		setBusy(true);
		try {
			// Dynamic import keeps pptxgenjs + our builder off the main chunk. The
			// logo fetch is independent of it, so both go out at once rather than
			// the ~1 MB library download gating the start of a network round trip.
			const [[{ default: PptxGenJS }, { deckToPptx, pptxFileName }], logo] =
				await Promise.all([
					Promise.all([import("pptxgenjs"), import("#/lib/deck-to-pptx")]),
					fetchClubLogo(logoUrl),
				]);
			const title = deck.find((s) => s.kind === "title");
			const fileName = title
				? pptxFileName(clubName, title.scheduledAt, title.timezone)
				: `${clubName} Agenda.pptx`;
			const pptx = deckToPptx(PptxGenJS, deck, logo);
			await pptx.writeFile({ fileName });
		} catch (err) {
			console.error("pptx export failed", err);
			toast.error("Could not build the PowerPoint file.");
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
