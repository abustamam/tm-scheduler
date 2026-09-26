// The square flyer, previewed and downloadable as a PNG (#931). Shared by the
// Promote sheet and the public `/flyer` route so the export path is one piece
// of code.
//
// Two copies of the layout are mounted: a SCALED preview the officer looks at,
// and the real 1080x1080 box parked off-screen, which is what gets exported.
// The off-screen positioning sits on a WRAPPER, never on the exported node —
// `html-to-image` copies the node's own computed style into the image, so a
// `left: -20000px` there would draw it off its own canvas.

import { Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { exportSquarePng, imageToDataUrl } from "#/lib/flyer-png";
import type { FlyerContent } from "#/lib/promo-template";
import { FLYER_SQUARE_PX, MeetingFlyerSquare } from "./meeting-flyer";

/** The logo as a data URL, fetched once per URL. `error` is set when it could
 *  not be inlined — the export refuses then rather than dropping the logo. */
function useInlinedLogo(logoUrl: string | null) {
	const [state, setState] = useState<{
		src: string | null;
		error: string | null;
	}>({ src: null, error: null });
	useEffect(() => {
		let cancelled = false;
		setState({ src: null, error: null });
		if (!logoUrl) return;
		imageToDataUrl(logoUrl)
			.then((src) => {
				if (!cancelled) setState({ src, error: null });
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setState({
						src: null,
						error: err instanceof Error ? err.message : "Logo unavailable.",
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [logoUrl]);
	return state;
}

export function FlyerSquareExport({
	content,
	clubName,
	logoUrl,
	filename,
	previewWidth = 320,
}: {
	content: FlyerContent;
	clubName: string;
	/** Versioned logo URL, or null when the club has none. */
	logoUrl: string | null;
	filename: string;
	previewWidth?: number;
}) {
	const exportRef = useRef<HTMLDivElement>(null);
	const logo = useInlinedLogo(logoUrl);
	const [busy, setBusy] = useState(false);
	const scale = previewWidth / FLYER_SQUARE_PX;
	// The club HAS a logo but it is not inlined yet (or failed): the export
	// would be missing it, so it waits.
	const logoPending = Boolean(logoUrl) && !logo.src;
	const ready = Boolean(content.meetingLink) && !logoPending;

	async function download() {
		const node = exportRef.current?.querySelector<HTMLElement>(
			"[data-flyer-square]",
		);
		if (!node) return;
		setBusy(true);
		try {
			const dataUrl = await exportSquarePng(node);
			const a = document.createElement("a");
			a.href = dataUrl;
			a.download = filename;
			a.click();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't make the image.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			<div
				aria-hidden
				className="overflow-hidden rounded-md border"
				style={{ width: previewWidth, height: previewWidth }}
			>
				<div
					style={{
						width: FLYER_SQUARE_PX,
						height: FLYER_SQUARE_PX,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
				>
					<MeetingFlyerSquare
						content={content}
						clubName={clubName}
						logoSrc={logo.src ?? logoUrl}
					/>
				</div>
			</div>
			<div
				ref={exportRef}
				aria-hidden
				style={{
					position: "fixed",
					left: -20000,
					top: 0,
					pointerEvents: "none",
				}}
			>
				<MeetingFlyerSquare
					content={content}
					clubName={clubName}
					logoSrc={logo.src}
				/>
			</div>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={download}
				disabled={!ready || busy}
				aria-busy={busy}
			>
				{busy ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<Download className="size-4" aria-hidden />
				)}
				Download image (PNG)
			</Button>
			{logo.error ? (
				<p className="text-destructive text-xs">
					{logo.error} The image can't be made without it.
				</p>
			) : null}
		</div>
	);
}
