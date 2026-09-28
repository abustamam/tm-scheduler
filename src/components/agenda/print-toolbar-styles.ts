// src/components/agenda/print-toolbar-styles.ts
//
// The inline styles of the controls each print route puts in its
// `PrintToolbar`. They live here, not in the routes, so that
// `print-toolbar-geometry.test.tsx` measures the SHIPPED values: a route that
// repaints a tab fails the toolbar's contrast gate instead of leaving a copy in
// the test green (#998). Each route still owns which of these it renders.
import type React from "react";
import { INK, MUTED } from "./print-theme";

/** The agenda print route's layout tabs (Grid / Editorial / Timing / Spacious). */
export const AGENDA_TAB_STYLE: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 600,
	color: MUTED,
	textDecoration: "none",
};

/** Spread over `AGENDA_TAB_STYLE` on the selected layout's tab. */
export const AGENDA_TAB_ACTIVE_STYLE: React.CSSProperties = {
	background: INK,
	color: "#fff",
};

/** The flyer route's Poster / Square image tabs. */
export const flyerTabStyle = (active: boolean): React.CSSProperties => ({
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	textDecoration: "none",
	color: active ? "#fff" : INK,
	background: active ? INK : "transparent",
});

/**
 * The roles sheet's screen-only wayfinding pill (#542, F-009): that
 * print-styled page has no header/nav, and guests arriving via shared links
 * dead-ended on it. It is the `PrintToolbar`'s `leading` item, so it shares
 * the toolbar's in-flow row above the sheet (#998) instead of floating over
 * it. Truncates so a long club name keeps the row to one line beside the
 * toolbar card on a phone.
 */
export const ROLES_BACK_LINK_STYLE: React.CSSProperties = {
	display: "block",
	minWidth: 0,
	maxWidth: "min(48vw, 320px)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	background: "#fff",
	borderRadius: 10,
	padding: "9px 14px",
	boxShadow: "0 6px 20px rgba(23,58,64,.18)",
	color: INK,
	fontSize: 13,
	fontWeight: 700,
	textDecoration: "none",
};
