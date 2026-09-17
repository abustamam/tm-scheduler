import type { FitBox } from "#/lib/slide-fit";
import {
	SLIDE_BODY_BOTTOM_PCT,
	SLIDE_HEADER_GAP_PCT,
	SLIDE_INSET_PCT,
} from "#/lib/slide-spacing";

/** One cqw on a 1280px-wide slide. */
const CQW_1280 = 12.8;

/**
 * A content slide's body box at 1280×720 (#767).
 *
 * The PADDING comes from the same `slide-spacing` constants the component
 * renders with, so changing the real gap under the header rule changes this
 * fixture too. `clientHeight` is what the live deck measured for that box —
 * it is what is left of 720px after the header and footer, which no constant
 * states on its own.
 */
export const SLIDE_BODY_BOX_1280: FitBox = {
	clientWidth: 1280,
	clientHeight: 457,
	paddingTop: SLIDE_HEADER_GAP_PCT * CQW_1280,
	paddingRight: SLIDE_INSET_PCT * CQW_1280,
	paddingBottom: SLIDE_BODY_BOTTOM_PCT * CQW_1280,
	paddingLeft: SLIDE_INSET_PCT * CQW_1280,
};

/** The body room that box leaves, derived rather than restated. */
export const SLIDE_BODY_ROOM_1280 = {
	width:
		SLIDE_BODY_BOX_1280.clientWidth -
		SLIDE_BODY_BOX_1280.paddingLeft -
		SLIDE_BODY_BOX_1280.paddingRight,
	height:
		SLIDE_BODY_BOX_1280.clientHeight -
		SLIDE_BODY_BOX_1280.paddingTop -
		SLIDE_BODY_BOX_1280.paddingBottom,
};
