/** The band present mode keeps empty for a video call's own controls (#1468).
 *
 *  The call app draws its toolbar and thumbnail strip at a FIXED pixel size over
 *  whatever window is shared, so the band is fixed CSS pixels, not a share of
 *  the screen. Which edge is the presenter's choice (the controls are draggable
 *  and differ by app version), remembered in this browser only: it describes one
 *  laptop's call setup, not the club or the meeting. */

export const BAND_EDGES = ["none", "top", "right", "bottom", "left"] as const;
export type BandEdge = (typeof BAND_EDGES)[number];

export const BAND_STORAGE_KEY = "gavelup:present-call-band";

/** Thickness of the band, in CSS px. */
export const BAND_PX: Record<Exclude<BandEdge, "none">, number> = {
	top: 72,
	bottom: 72,
	left: 260,
	right: 260,
};

export function isBandEdge(v: unknown): v is BandEdge {
	return typeof v === "string" && (BAND_EDGES as readonly string[]).includes(v);
}

/** none -> top -> right -> bottom -> left -> none. */
export function nextBandEdge(edge: BandEdge): BandEdge {
	return BAND_EDGES[(BAND_EDGES.indexOf(edge) + 1) % BAND_EDGES.length];
}

/** Insets (px) the slide stage keeps clear of the band. */
export function bandInsets(edge: BandEdge): {
	top: number;
	right: number;
	bottom: number;
	left: number;
} {
	const insets = { top: 0, right: 0, bottom: 0, left: 0 };
	if (edge !== "none") insets[edge] = BAND_PX[edge];
	return insets;
}

export function bandLabel(edge: BandEdge): string {
	return `Space for call controls: ${edge}`;
}

/** Storage can throw (private window, blocked site data) and can hold anything. */
export function readBandEdge(): BandEdge {
	try {
		const v = window.localStorage.getItem(BAND_STORAGE_KEY);
		return isBandEdge(v) ? v : "none";
	} catch {
		return "none";
	}
}

export function writeBandEdge(edge: BandEdge): void {
	try {
		window.localStorage.setItem(BAND_STORAGE_KEY, edge);
	} catch {
		// Not remembered; the band still applies for this page view.
	}
}
