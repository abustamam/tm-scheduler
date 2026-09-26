/**
 * A QR code as horizontal runs of dark modules, for drawing it out of native
 * rectangles in the `.pptx` export (#932).
 *
 * Why not an image: pptxgenjs embeds an SVG only alongside a PNG preview it
 * rasterises through a browser `<canvas>` (`createSvgPngPreview`), which does
 * not exist under the export's own tests; a raster QR would need that same
 * canvas. Rectangles need nothing, stay sharp at any projector size, and one
 * per RUN rather than per module keeps a typical code to a few hundred shapes.
 *
 * The encoder is the one the projected deck already uses — `qrcode.react`'s
 * `QRCodeSVG`, rendered to markup and read back — so the export and the screen
 * encode the same URL the same way, with no second QR library in the bundle.
 * `QRCodeSVG` draws its dark modules as one path of `M{x} {y}h{w}v1H{x}z`
 * segments; `qr-runs.test.ts` pins that shape, so a library upgrade that changes
 * it fails there by name rather than exporting a blank square.
 */
import { QRCodeSVG } from "qrcode.react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export type QrRun = { x: number; y: number; w: number };
export type QrRuns = { size: number; runs: QrRun[] };

const RUN = /M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g;

export function qrRuns(value: string): QrRuns {
	const svg = renderToStaticMarkup(
		createElement(QRCodeSVG, { value, marginSize: 0 }),
	);
	const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)?.[1] ?? 0);
	// The dark path is the one that is not the full-bleed white background.
	const dark = [...svg.matchAll(/<path[^>]*d="([^"]*)"/g)]
		.map((m) => m[1] ?? "")
		.find((d) => !d.startsWith("M0,0 h"));
	const runs: QrRun[] = [];
	for (const m of (dark ?? "").matchAll(RUN)) {
		runs.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) });
	}
	if (size === 0 || runs.length === 0) {
		throw new Error(`Could not read a QR code for ${value}.`);
	}
	return { size, runs };
}
