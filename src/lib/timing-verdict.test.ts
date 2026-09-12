/**
 * The derived qualification verdict (#730).
 *
 * BOUNDARY INSTANTS, in seconds, because that is the unit the row stores. The
 * window is inclusive at both ends — "from 0:30 before green THROUGH 0:30 after
 * red" — so the cases that matter are exactly 4:30 and exactly 7:30, and the
 * single seconds either side of them.
 */
import { describe, expect, it } from "vitest";
import { TIMING_VERDICT_LABEL, timingVerdict } from "./timing-verdict";
import { qualifyingWindow, TIMING_GRACE_MINUTES } from "./timing-window";

/** A standard 5–7 speech. Qualifying window 4:30–7:30. */
const MARKS = { markGreen: 5, markRed: 7 };

describe("a speech against a 5–7 window", () => {
	it("qualifies AT the lower edge, and is under one second below it", () => {
		expect(timingVerdict(270, MARKS, "speech")).toBe("qualified"); // 4:30
		expect(timingVerdict(269, MARKS, "speech")).toBe("under");
	});

	it("qualifies AT the upper edge, and is over one second above it", () => {
		expect(timingVerdict(450, MARKS, "speech")).toBe("qualified"); // 7:30
		expect(timingVerdict(451, MARKS, "speech")).toBe("over");
	});

	it("qualifies across the whole assigned range", () => {
		for (const s of [300, 360, 371, 420]) {
			expect(timingVerdict(s, MARKS, "speech"), `${s}s`).toBe("qualified");
		}
	});

	it("is under at zero", () => {
		expect(timingVerdict(0, MARKS, "speech")).toBe("under");
	});

	it("reads the grace from timing-window rather than restating 0:30", () => {
		// Pins the SOURCE. A hardcoded 30 here would keep every case above green
		// while the printed agenda's own window moved.
		const w = qualifyingWindow(MARKS.markGreen, MARKS.markRed);
		expect(w?.fromMinutes).toBe(5 - TIMING_GRACE_MINUTES);
		expect(w?.toMinutes).toBe(7 + TIMING_GRACE_MINUTES);
		expect(w?.range).toBe("4:30–7:30");
	});
});

describe("a window whose lower edge crosses zero", () => {
	it("never treats a short speech as under when the floor clamps at zero", () => {
		// A 0.25–2 minute beat: green minus the grace is negative, and
		// `qualifyingWindow` clamps it at 0. Everything from the first second on
		// is therefore inside the window, which is the honest reading of a floor
		// the club set below the grace.
		const short = { markGreen: 0.25, markRed: 2 };
		expect(qualifyingWindow(0.25, 2)?.fromMinutes).toBe(0);
		expect(timingVerdict(1, short, "speech")).toBe("qualified");
		expect(timingVerdict(150, short, "speech")).toBe("qualified"); // 2:30
		expect(timingVerdict(151, short, "speech")).toBe("over");
	});
});

describe("marks that do not describe a window", () => {
	it("is unknown when both marks are null", () => {
		expect(
			timingVerdict(371, { markGreen: null, markRed: null }, "speech"),
		).toBe("unknown");
	});

	it("is unknown when only one edge is set", () => {
		// A half-stated window cannot be judged: `speechWindow` is the one rule
		// for that across the app, and inventing the missing edge from a default
		// would mix the club's number with ours.
		expect(timingVerdict(371, { markGreen: 5, markRed: null }, "speech")).toBe(
			"unknown",
		);
		expect(timingVerdict(371, { markGreen: null, markRed: 7 }, "speech")).toBe(
			"unknown",
		);
	});

	it("is unknown at every elapsed time, not merely at the edges", () => {
		for (const s of [0, 1, 371, 100_000]) {
			expect(
				timingVerdict(s, { markGreen: null, markRed: null }, "speech"),
				`${s}s`,
			).toBe("unknown");
		}
	});
});

describe("the verdict is a function of the STORED marks alone", () => {
	it("two rows measured identically against different windows disagree", () => {
		// The property the copied marks buy: an officer who widens the agenda's
		// min/max next month must not re-decide a speech recorded last month, and
		// the only way this function could let them is by reading a live value.
		// It takes marks as an argument, so there is nothing live to read — and
		// this is what makes that observable.
		const at = 460; // 7:40
		expect(timingVerdict(at, { markGreen: 5, markRed: 7 }, "speech")).toBe(
			"over",
		);
		expect(timingVerdict(at, { markGreen: 5, markRed: 8 }, "speech")).toBe(
			"qualified",
		);
	});
});

describe("TIMING_VERDICT_LABEL", () => {
	it("names every verdict, so a new one cannot print blank", () => {
		expect(Object.keys(TIMING_VERDICT_LABEL).sort()).toEqual([
			"over",
			"qualified",
			"under",
			"unknown",
		]);
		for (const label of Object.values(TIMING_VERDICT_LABEL)) {
			expect(label.trim()).not.toBe("");
		}
	});
});
