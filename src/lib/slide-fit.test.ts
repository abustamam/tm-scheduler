import { describe, expect, it } from "vitest";
import {
	SLIDE_BODY_BOX_1280 as BOX,
	SLIDE_BODY_ROOM_1280 as ROOM,
} from "#/test/slide-fit-box";
import { fitScale } from "./slide-fit";

describe("fitScale", () => {
	it("fits the body to the box's CONTENT area, not its padding box (#767)", () => {
		// 457 − 51.2 − 19.2 = 386.6px of room for the 523px body the live deck
		// measured. Dividing by the padding box instead (457 / 523 = 0.874) is
		// the bug: the body still spills past the footer rule.
		expect(ROOM.height).toBeCloseTo(386.6, 6);
		expect(fitScale(BOX, { width: ROOM.width, height: 523 })).toBeCloseTo(
			ROOM.height / 523,
			6,
		);
	});

	it("never enlarges a body that already fits", () => {
		expect(fitScale(BOX, { width: ROOM.width, height: 317 })).toBe(1);
	});

	it("does not shrink a body that fits but for pixel rounding", () => {
		// The body is `w-full`, so its scrollWidth IS the content width, rounded
		// to a whole pixel: 1076 against 1075.2 of room. Scaling every slide by
		// 0.9993 for that would soften all of its text.
		expect(ROOM.width).toBeCloseTo(1075.2, 6);
		expect(fitScale(BOX, { width: 1076, height: 387 })).toBe(1);
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
