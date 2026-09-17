/** The box a slide body is laid out in, as the browser reports it. */
export type FitBox = {
	clientWidth: number;
	clientHeight: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
};

/**
 * The scale that fits a slide body's natural size inside its box.
 *
 * Divides by the CONTENT area. `clientWidth`/`clientHeight` include the box's
 * padding, and the content slide's body box has 4cqw of it above (the gap under
 * the header rule) and 1.5cqw below — so a scale computed against the padding
 * box still left an overlong body clipping its last line behind the footer
 * (#767, "Time: 20 min" half-hidden on a real deck).
 *
 * Never enlarges (capped at 1), ignores a sub-pixel shortfall, and returns 1 for a body or box with no size,
 * where any other answer would scale the slide to nothing.
 */
export function fitScale(
	box: FitBox,
	natural: { width: number; height: number },
): number {
	const width = box.clientWidth - box.paddingLeft - box.paddingRight;
	const height = box.clientHeight - box.paddingTop - box.paddingBottom;
	if (natural.width <= 0 || natural.height <= 0) return 1;
	if (width <= 0 || height <= 0) return 1;
	// A pixel of slack per axis. `scrollWidth`/`scrollHeight` are rounded to
	// whole pixels while the padding is fractional (cqw), so a body that exactly
	// fits can report 1076 against 1075.6 of room — and a 0.9996 scale on every
	// slide softens all of its text for no visible gain.
	const kw = natural.width > width + 1 ? width / natural.width : 1;
	const kh = natural.height > height + 1 ? height / natural.height : 1;
	return Math.min(kw, kh);
}
