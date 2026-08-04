import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";

/**
 * Downloads the present-mode deck as an editable `.pptx`. Same ungated
 * visibility as Present/Print. Generation happens entirely client-side and the
 * ~1 MB `pptxgenjs` library is dynamic-`import()`ed only on click, so it is
 * code-split out of the main bundle (see `deck-to-pptx.ts`).
 */
/**
 * Fetch the club's logo and encode it for pptxgenjs, or null.
 *
 * Deliberately best-effort: a missing or failed logo must never cost someone
 * their deck, so every failure path returns null and the export proceeds
 * without an image. The URL is the same one the projected deck already renders,
 * so the service worker has normally cached it — which is what makes this work
 * offline, the case Present mode exists for.
 */
async function fetchLogoDataUri(
	logoUrl: string | null,
): Promise<string | null> {
	if (!logoUrl) return null;
	try {
		const res = await fetch(logoUrl);
		if (!res.ok) return null;
		const blob = await res.blob();
		return await new Promise<string | null>((resolve) => {
			const reader = new FileReader();
			reader.onloadend = () =>
				resolve(typeof reader.result === "string" ? reader.result : null);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	} catch {
		return null;
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
			// Dynamic import keeps pptxgenjs + our builder off the main chunk.
			const [{ default: PptxGenJS }, { deckToPptx, pptxFileName }] =
				await Promise.all([import("pptxgenjs"), import("#/lib/deck-to-pptx")]);
			const title = deck.find((s) => s.kind === "title");
			const fileName = title
				? pptxFileName(clubName, title.scheduledAt, title.timezone)
				: `${clubName} Agenda.pptx`;
			const logoDataUri = await fetchLogoDataUri(logoUrl);
			const pptx = deckToPptx(PptxGenJS, deck, logoDataUri);
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
