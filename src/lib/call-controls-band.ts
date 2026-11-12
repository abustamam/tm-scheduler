/** The band present mode keeps empty for a video call's own controls (#1468).
 *
 *  The call app draws its toolbar and thumbnail strip at a FIXED pixel size over
 *  whatever window is shared, so the band is fixed CSS pixels, not a share of
 *  the screen. Which edge is the presenter's choice (the controls are draggable
 *  and differ by app version), remembered in this browser only: it describes one
 *  laptop's call setup, not the club or the meeting. */

export type CallControlsEdge = "none" | "top" | "right" | "bottom" | "left";

export const CALL_CONTROLS_EDGES: readonly CallControlsEdge[] = [
	"none",
	"top",
	"right",
	"bottom",
	"left",
];

export const CALL_CONTROLS_STORAGE_KEY = "gavelup:present-call-controls";

/** Thickness in CSS px: top/bottom height, left/right width. */
export const CALL_CONTROLS_BAND_PX = {
	horizontal: 72,
	vertical: 260,
} as const;

/** none -> top -> right -> bottom -> left -> none. */
export function nextCallControlsEdge(e: CallControlsEdge): CallControlsEdge {
	return CALL_CONTROLS_EDGES[
		(CALL_CONTROLS_EDGES.indexOf(e) + 1) % CALL_CONTROLS_EDGES.length
	];
}

/** Storage can hold anything: unknown or null reads as "none". */
export function parseCallControlsEdge(raw: string | null): CallControlsEdge {
	return CALL_CONTROLS_EDGES.find((e) => e === raw) ?? "none";
}

/** Insets (px) the slide stage keeps clear of the band. */
export function callControlsInset(e: CallControlsEdge): {
	top: number;
	right: number;
	bottom: number;
	left: number;
} {
	const inset = { top: 0, right: 0, bottom: 0, left: 0 };
	if (e === "top" || e === "bottom")
		inset[e] = CALL_CONTROLS_BAND_PX.horizontal;
	if (e === "left" || e === "right") inset[e] = CALL_CONTROLS_BAND_PX.vertical;
	return inset;
}

/** The edge as the presenter reads it: "off" for none. */
export function callControlsEdgeName(e: CallControlsEdge): string {
	return e === "none" ? "off" : e;
}

export function callControlsLabel(e: CallControlsEdge): string {
	return `Space for call controls: ${callControlsEdgeName(e)}`;
}

/** Storage can throw (private window, blocked site data). */
export function readCallControlsEdge(): CallControlsEdge {
	try {
		return parseCallControlsEdge(
			window.localStorage.getItem(CALL_CONTROLS_STORAGE_KEY),
		);
	} catch {
		return "none";
	}
}

export function writeCallControlsEdge(e: CallControlsEdge): void {
	try {
		window.localStorage.setItem(CALL_CONTROLS_STORAGE_KEY, e);
	} catch {
		// Not remembered; the band still applies for this page view.
	}
}
