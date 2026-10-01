/**
 * The printed agenda's layouts (#1069): the ONE list of their ids.
 *
 * Before this module the ids were written out twice, as the `AgendaLayout`
 * union in `meeting-agenda-print.tsx` and as the print route's tab list, and
 * the default ("grid") was hard-coded in two more places. Now the pg enum
 * `agenda_print_layout` (`clubs.default_print_layout`), the settings schema's
 * zod enum and the print route's tabs are all built from `AGENDA_LAYOUTS`, and
 * `agenda-layouts.guard.test.ts` fails if any of them stops being exactly it.
 *
 * The ORDER is the tab order: the one-page layouts lead, because clubs prefer a
 * single-page agenda and both one-pagers carry colour-coded timing.
 */
export const AGENDA_LAYOUTS = [
	"grid",
	"editorial",
	"timing",
	"spacious",
] as const;

export type AgendaLayout = (typeof AGENDA_LAYOUTS)[number];

/** What each layout is called on the print toolbar and in Club settings. */
export const AGENDA_LAYOUT_LABELS: Record<AgendaLayout, string> = {
	grid: "Grid",
	editorial: "Editorial",
	timing: "Timing",
	spacious: "Spacious",
};

/**
 * One line about each layout, for a picker. The page counts are the layouts'
 * real ones, the same numbers `print-page-count.test.tsx` pins; change a
 * layout's length and this copy is what has to follow it.
 */
export const AGENDA_LAYOUT_HINTS: Record<AgendaLayout, string> = {
	grid: "One page",
	editorial: "One page",
	timing: "Two pages",
	spacious: "Two pages, larger type",
};

/** The print toolbar's marker on the club default's tab (#1069). */
export const CLUB_DEFAULT_LABEL = "Club default";

export function isAgendaLayout(value: unknown): value is AgendaLayout {
	return (
		typeof value === "string" &&
		(AGENDA_LAYOUTS as readonly string[]).includes(value)
	);
}
