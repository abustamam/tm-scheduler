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
 * padding, and the content slide's body box carries `SLIDE_HEADER_GAP_PCT` of
 * it above (the gap under the header rule) and `SLIDE_BODY_BOTTOM_PCT` below,
 * which are not equal — so a scale computed against the padding box still left
 * an overlong body clipping its last line behind the footer (#767, "Time: 20
 * min" half-hidden on a real deck). Named rather than written out: this line
 * said "4cqw above and 1.5cqw below" until #724 retuned the second one, which
 * is the same hand-kept-copy drift that issue was about.
 *
 * Height is where this matters and where it is exact: the body box centres
 * its child vertically, so overflow is even top and bottom and a scale about
 * the body's centre lands it inside. Width only ever binds on content that
 * cannot wrap (the body is `w-full`, so wrapped text measures exactly the
 * room); such content overflows to the right only, and the centred scale does
 * not fully contain it.
 *
 * Never enlarges (capped at 1), ignores a shortfall of up to one pixel, and
 * returns 1 for a body or box with no size,
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
	// fits can report 1076 against 1075.2 of room — and a 0.9996 scale on every
	// slide softens all of its text for no visible gain.
	const kw = natural.width > width + 1 ? width / natural.width : 1;
	const kh = natural.height > height + 1 ? height / natural.height : 1;
	return Math.min(kw, kh);
}
