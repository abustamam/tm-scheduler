import { describe, expect, it } from "vitest";
import { fitScale } from "./slide-fit";

// The body box of a content slide at 1280×720, as measured on the live deck
// for #767: 4cqw of top padding (the gap under the header rule), 1.5cqw at the
// bottom, 8cqw either side, where 1cqw = 12.8px.
const BOX = {
	clientWidth: 1280,
	clientHeight: 457,
	paddingTop: 51.2,
	paddingRight: 102.4,
	paddingBottom: 19.2,
	paddingLeft: 102.4,
};

describe("fitScale", () => {
	it("fits the body to the box's CONTENT area, not its padding box (#767)", () => {
		// 457 − 51.2 − 19.2 = 386.6px of room for a 523px body. Dividing by the
		// padding box instead (457 / 523 = 0.874) is the bug: the body still
		// spills past the footer rule by about half the padding difference.
		expect(fitScale(BOX, { width: 1075.2, height: 523 })).toBeCloseTo(
			386.6 / 523,
			6,
		);
	});

	it("never enlarges a body that already fits", () => {
		expect(fitScale(BOX, { width: 1075.2, height: 317 })).toBe(1);
	});

	it("does not shrink a body that fits but for pixel rounding", () => {
		// The body is `w-full`, so its scrollWidth IS the content width, rounded
		// to a whole pixel: 1076 against 1075.2 of room. Scaling every slide by
		// 0.9993 for that would soften all of its text.
		expect(fitScale(BOX, { width: 1076, height: 387 })).toBe(1);
	});

	it("binds on width when the body is too wide", () => {
		// 1280 − 204.8 = 1075.2px across.
		expect(fitScale(BOX, { width: 2150.4, height: 100 })).toBeCloseTo(0.5, 6);
	});

	it("leaves an unmeasured body alone rather than scaling it to nothing", () => {
		// A body with no size yet (not laid out) or a box with no room reports
		// zeros; scale(0) or a negative scale would make the slide blank.
		expect(fitScale(BOX, { width: 0, height: 0 })).toBe(1);
		expect(
			fitScale({ ...BOX, clientHeight: 60 }, { width: 1075.2, height: 523 }),
		).toBe(1);
	});
});
