/**
 * The app shell's sticky chrome, stated once as two CSS custom properties
 * (#999 follow-up).
 *
 * The shell stacks up to two sticky bars at the top of the page: the
 * impersonation banner (`h-9`, 2.25rem, only while a superadmin is viewing as
 * a club) and the header under it. Anything else that pins itself below them,
 * such as the meeting page's attendance rail, has to know how far down that
 * stack reaches. It used to hard-code `top-24` (6rem), which clears the header
 * alone and NOT the banner too: impersonating, the header's bottom sits at
 * ~105px, the rail pinned at 96px, and the header covered its top ~9px. Its
 * height cap, `100vh - 7rem`, was sized for the same 6rem, so pushing the rail
 * down without it would have left its bottom below the viewport.
 *
 * So the shell sets these on its root and everything reads them:
 * - {@link SHELL_BANNER_OFFSET_VAR}: where the header pins (0 or the banner).
 * - {@link SHELL_PINNED_TOP_VAR}: where a column pinned below the header pins.
 *   A reader caps its height at `100vh - this - 1rem`.
 *
 * Tailwind reads class names out of source text, so a consumer's class string
 * must spell the property name literally; `roster-action-row-geometry.test.ts`
 * checks the two stay the same name, and measures the rail with the banner up
 * and down.
 */
import type { CSSProperties } from "react";

export const SHELL_BANNER_OFFSET_VAR = "--shell-banner-offset";
export const SHELL_PINNED_TOP_VAR = "--shell-pinned-top";

/** The impersonation banner's height: its `h-9`. */
export const IMPERSONATION_BANNER_HEIGHT = "2.25rem";

/**
 * How far below the top of the sticky stack a pinned column sits: the
 * header (~69px) plus breathing room. The `top-24` the rail always had.
 */
export const PINNED_BELOW_HEADER = "6rem";

export function shellStickyVars(impersonating: boolean): CSSProperties {
	const banner = impersonating ? IMPERSONATION_BANNER_HEIGHT : "0px";
	return {
		[SHELL_BANNER_OFFSET_VAR]: banner,
		[SHELL_PINNED_TOP_VAR]: `calc(${banner} + ${PINNED_BELOW_HEADER})`,
	} as CSSProperties;
}
