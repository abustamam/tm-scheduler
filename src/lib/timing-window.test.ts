import { describe, expect, it } from "vitest";
import {
	firstQualifyingWindow,
	formatTimingClock,
	graceNote,
	graceSentence,
	qualifyingWindow,
	qualifyingWindowForMarks,
	TIMING_GRACE_MINUTES,
} from "./timing-window";

describe("formatTimingClock", () => {
	it("renders whole and half minutes the way the timing marks do", () => {
		expect(formatTimingClock(5)).toBe("5:00");
		expect(formatTimingClock(6.5)).toBe("6:30");
		expect(formatTimingClock(0.5)).toBe("0:30");
	});

	it("never renders a negative clock", () => {
		expect(formatTimingClock(-0.5)).toBe("0:00");
		expect(formatTimingClock(-12)).toBe("0:00");
	});

	it("carries a rounded-up 60 seconds into the next minute", () => {
		expect(formatTimingClock(5.999)).toBe("6:00");
	});
});

describe("qualifyingWindow", () => {
	it("is the 30-second grace either side of green and red", () => {
		const w = qualifyingWindow(5, 7);
		expect(w).not.toBeNull();
		expect(w?.fromMinutes).toBe(4.5);
		expect(w?.toMinutes).toBe(7.5);
		expect(w?.from).toBe("4:30");
		expect(w?.to).toBe("7:30");
		expect(w?.range).toBe("4:30–7:30");
		expect(w?.assigned).toBe("5:00–7:00");
	});

	it("derives its own window for a 2–3 minute evaluation", () => {
		const w = qualifyingWindow(2, 3);
		expect(w?.range).toBe("1:30–3:30");
		expect(w?.assigned).toBe("2:00–3:00");
	});

	it("is null for a slot with no min and no max", () => {
		expect(qualifyingWindow(null, null)).toBeNull();
		expect(qualifyingWindow(undefined, undefined)).toBeNull();
	});

	it("is null for a min-only slot (a window needs both ends)", () => {
		expect(qualifyingWindow(5, null)).toBeNull();
		expect(qualifyingWindow(null, 7)).toBeNull();
	});

	it("is null for a nonsense range or non-finite input", () => {
		expect(qualifyingWindow(7, 5)).toBeNull();
		expect(qualifyingWindow(Number.NaN, 5)).toBeNull();
		expect(qualifyingWindow(5, Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("clamps the lower end at zero rather than going negative", () => {
		// A one-minute item: 0:30 grace lands exactly on zero, not below it.
		expect(qualifyingWindow(1, 2)?.from).toBe("0:30");
		// A sub-grace minimum would cross zero — clamp instead of "-0:15".
		const tiny = qualifyingWindow(0.25, 1);
		expect(tiny?.fromMinutes).toBe(0);
		expect(tiny?.from).toBe("0:00");
		expect(tiny?.range).toBe("0:00–1:30");
	});

	it("exposes the grace period as half a minute", () => {
		expect(TIMING_GRACE_MINUTES).toBe(0.5);
	});
});

describe("qualifyingWindowForMarks", () => {
	it("reads green as the minimum and red as the maximum", () => {
		expect(
			qualifyingWindowForMarks({ green: 5, yellow: 6, red: 7 })?.range,
		).toBe("4:30–7:30");
	});

	it("is null for an untimed beat", () => {
		expect(qualifyingWindowForMarks(null)).toBeNull();
		expect(qualifyingWindowForMarks(undefined)).toBeNull();
	});
});

describe("firstQualifyingWindow", () => {
	it("picks the first timed beat on the agenda", () => {
		const w = firstQualifyingWindow([
			{ marks: null },
			{ marks: { green: 5, yellow: 6, red: 7 } },
			{ marks: { green: 2, yellow: 2.5, red: 3 } },
		]);
		expect(w?.range).toBe("4:30–7:30");
	});

	it("is null when nothing on the agenda is timed", () => {
		expect(
			firstQualifyingWindow([{ marks: null }, { marks: null }]),
		).toBeNull();
		expect(firstQualifyingWindow([])).toBeNull();
	});
});

describe("grace copy", () => {
	it("makes the rule concrete when the agenda has a timed beat", () => {
		const w = qualifyingWindow(5, 7);
		expect(graceNote(w)).toBe(
			"±0:30 grace — e.g. a 5:00–7:00 speech qualifies 4:30–7:30",
		);
		expect(graceSentence(w)).toBe(
			"A speech qualifies from 0:30 before green through 0:30 after red — a 5:00–7:00 speech qualifies between 4:30 and 7:30.",
		);
	});

	it("still states the rule with no timed beat to make it concrete", () => {
		expect(graceNote(null)).toBe(
			"±0:30 grace — 0:30 before green through 0:30 after red",
		);
		expect(graceSentence(null)).toBe(
			"A speech qualifies from 0:30 before green through 0:30 after red.",
		);
	});
});
