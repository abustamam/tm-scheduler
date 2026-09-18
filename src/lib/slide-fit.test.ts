import { describe, expect, it } from "vitest";
import {
	SLIDE_BODY_BOX_1280 as BOX,
	SLIDE_BODY_ROOM_1280 as ROOM,
} from "#/test/slide-fit-box";
import { fitScale } from "./slide-fit";

describe("fitScale", () => {
	it("fits the body to the box's CONTENT area, not its padding box (#767)", () => {
		// The claim in this test's NAME, stated as a property: the room is a
		// strict, non-degenerate subset of the padding box on both axes. That is
		// what "content area" means, and it is the one thing about ROOM the
		// fixture cannot establish about itself — it derives the room by
		// SUBTRACTING the two paddings, so re-deriving it here with the same
		// expression would assert nothing at all.
		//
		// It replaces a `toBeCloseTo(386.6)`, which restated the fixture's output
		// as a literal and went stale the moment #724 retuned the clearance above
		// the footer. Containment carries no number, so it cannot go stale again.
		//
		// It is also the anti-vacuity guard for the assertion below: if the room
		// ever equalled the padding box, that assertion would pass whether
		// `fitScale` divided by the content area or by the padding box, which is
		// precisely the distinction it exists to make.
		expect(ROOM.height).toBeGreaterThan(0);
		expect(ROOM.height).toBeLessThan(BOX.clientHeight);
		expect(ROOM.width).toBeGreaterThan(0);
		expect(ROOM.width).toBeLessThan(BOX.clientWidth);
		// The behaviour itself, on the 523px body the live deck measured: it
		// scales by the room. Dividing by the padding box instead gives a visibly
		// larger scale and the body still spills past the footer rule — the #767
		// bug, and what this rejects.
		expect(fitScale(BOX, { width: ROOM.width, height: 523 })).toBeCloseTo(
			ROOM.height / 523,
			6,
		);
	});

	it("never enlarges a body that already fits", () => {
		expect(fitScale(BOX, { width: ROOM.width, height: 317 })).toBe(1);
	});

	it("does not shrink a body that fits but for pixel rounding", () => {
		// WHY the allowance exists: the body is `w-full`, so its scrollWidth IS
		// the content width — and the browser reports scroll sizes as WHOLE
		// pixels while the room is fractional (cqw). The old literals were one
		// instance of that, 1076 against 1075.2 of room; scaling every slide by
		// the resulting 0.9993 would soften all of its text.
		//
		// WHAT is asserted is the threshold itself, at three points derived from
		// ROOM — inside the allowance, exactly on it, and past it. Deliberately
		// NOT `Math.ceil(ROOM.width)`, which is the realistic rounding case only
		// while the room happens to be fractional: at `SLIDE_INSET_PCT = 10` the
		// width room is a whole 1024 and `Math.ceil` overflows by nothing, so an
		// assertion built on it tests air on one retune and fails on another.
		// #724 already did that to the HEIGHT axis — the gap under the rule plus
		// the clearance above the footer now sum to a whole number of pixels, so
		// `ROOM.height` is exactly 361. Both axes get the same three points, so
		// neither can go quiet when the constants move.
		const sub = 0.5; // anywhere strictly inside the one-pixel allowance

		expect(
			fitScale(BOX, { width: ROOM.width + sub, height: ROOM.height + sub }),
		).toBe(1);

		// Exactly one pixel over is still tolerated: the comparison is
		// `natural > room + 1`, not `>=`. This is the upper bound, so it is
		// strictly harder than the sub-pixel case above and than the old literal
		// `387`, which sat 0.4px above the room of its day.
		expect(
			fitScale(BOX, { width: ROOM.width + 1, height: ROOM.height + 1 }),
		).toBe(1);

		// And a hair PAST the bound does scale, on each axis independently — so
		// this is a threshold rather than a blanket "close enough", and a
		// `fitScale` that never shrank anything cannot satisfy it.
		expect(
			fitScale(BOX, { width: ROOM.width, height: ROOM.height + 1.5 }),
		).toBeLessThan(1);
		expect(
			fitScale(BOX, { width: ROOM.width + 1.5, height: ROOM.height }),
		).toBeLessThan(1);
	});

	it("scales by the tighter axis when the body is too wide", () => {
		expect(fitScale(BOX, { width: ROOM.width * 2, height: 100 })).toBeCloseTo(
			0.5,
			6,
		);
	});

	it("leaves an unmeasured body alone rather than scaling it to nothing", () => {
		// A body with no size yet (not laid out) or a box with no room reports
		// zeros; scale(0) or a negative scale would make the slide blank.
		expect(fitScale(BOX, { width: 0, height: 0 })).toBe(1);
		expect(
			fitScale(
				{ ...BOX, clientHeight: 60 },
				{ width: ROOM.width, height: 523 },
			),
		).toBe(1);
	});
});
