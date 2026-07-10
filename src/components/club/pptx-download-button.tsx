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
			// Dynamic import keeps pptxgenjs + our builder off the main chunk.
			const [{ default: PptxGenJS }, { deckToPptx, pptxFileName }] =
				await Promise.all([import("pptxgenjs"), import("#/lib/deck-to-pptx")]);
			const title = deck.find((s) => s.kind === "title");
			const fileName = title
				? pptxFileName(clubName, title.scheduledAt, title.timezone)
				: `${clubName} Agenda.pptx`;
			const pptx = deckToPptx(PptxGenJS, deck);
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
