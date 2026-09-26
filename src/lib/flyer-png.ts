// The square flyer's PNG export (#931), made in the browser with
// `html-to-image`. No server rendering: the officer's own browser draws the
// node it is already showing.
//
// ## Why every image must already be a data URL
//
// `html-to-image` re-fetches each `<img>` to embed it, and when a fetch fails
// it does not throw — the image is simply missing from the PNG. A flyer whose
// club logo quietly vanished is exactly the failure an officer does not notice
// until it is in forty group chats. So the caller inlines the logo first
// (`imageToDataUrl`) and this REFUSES a node that still points anywhere else,
// turning a silent hole into an error the sheet shows. The QR is inline SVG,
// which is part of the DOM and needs no fetch.

/** The exported image's edge, in pixels. Matches the layout's CSS box. */
export const SQUARE_PNG_PX = 1080;

export const NOT_INLINED_MESSAGE =
	"An image on the flyer is not inlined yet, so it would be missing from the export. Try again in a moment.";

/** Throws when any `<img>` under `node` is not a `data:` URL. */
export function assertImagesInlined(node: Element): void {
	for (const img of Array.from(node.querySelectorAll("img"))) {
		const src = img.getAttribute("src") ?? "";
		if (!src.startsWith("data:")) throw new Error(NOT_INLINED_MESSAGE);
	}
}

/**
 * The square flyer as a PNG data URL, exactly `SQUARE_PNG_PX` on a side.
 * `node` is the 1080x1080 layout box itself — not a scaled preview, and not a
 * wrapper positioned off-screen, whose position would be copied into the image.
 */
export async function exportSquarePng(node: HTMLElement): Promise<string> {
	assertImagesInlined(node);
	const { toPng } = await import("html-to-image");
	return toPng(node, {
		width: SQUARE_PNG_PX,
		height: SQUARE_PNG_PX,
		pixelRatio: 1,
		backgroundColor: "#ffffff",
	});
}

/** Fetch an image and return it as a data URL. Throws on a failed fetch. */
export async function imageToDataUrl(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not load the club logo (${res.status}).`);
	const blob = await res.blob();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Could not read the club logo."));
		reader.readAsDataURL(blob);
	});
}
