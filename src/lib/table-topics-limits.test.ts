import { describe, expect, it } from "vitest";
import { TABLE_TOPICS_MARKS } from "./agenda-runsheet";
import {
	formatTableTopicsClock,
	formatTableTopicsTiming,
	hasTableTopicsLimits,
	MAX_TABLE_TOPICS_SECONDS,
	MIN_BARE_SECONDS,
	parseTableTopicsClock,
	resolveTableTopicsMarks,
	TABLE_TOPICS_DEFAULT_TIMING,
} from "./table-topics-limits";

/** MCF's printed rule: "1 min min, 2.3 min max, 2.31+ disqualified" — where
 *  "2.3 min" is how their sheet writes two minutes thirty. */
const MCF = { minSeconds: 60, maxSeconds: 150 };

describe("hasTableTopicsLimits", () => {
	it("needs BOTH bounds", () => {
		// A half-stated window cannot make timer marks, and filling the gap from
		// the default would print a window mixing the club's number with ours.
		expect(hasTableTopicsLimits({ minSeconds: 60, maxSeconds: null })).toBe(
			false,
		);
		expect(hasTableTopicsLimits({ minSeconds: null, maxSeconds: 150 })).toBe(
			false,
		);
		expect(hasTableTopicsLimits({ minSeconds: null, maxSeconds: null })).toBe(
			false,
		);
		expect(hasTableTopicsLimits(null)).toBe(false);
		expect(hasTableTopicsLimits(undefined)).toBe(false);
		expect(hasTableTopicsLimits(MCF)).toBe(true);
	});

	it("rejects a window that would put red before green", () => {
		// Worse than showing the default: it inverts the Timer's card.
		expect(hasTableTopicsLimits({ minSeconds: 150, maxSeconds: 60 })).toBe(
			false,
		);
		expect(hasTableTopicsLimits({ minSeconds: 90, maxSeconds: 90 })).toBe(
			false,
		);
	});

	it("rejects a FRACTIONAL row, which only the write path's .int() catches", () => {
		// The two surfaces would otherwise disagree by exactly the mechanism the
		// schema's `.int()` comment describes: the deck formats and rounds to
		// "2:30" while the Timer's card gets 2.5067 unrounded.
		const fractional = { minSeconds: 60.5, maxSeconds: 150.4 };
		expect(hasTableTopicsLimits(fractional)).toBe(false);
		expect(resolveTableTopicsMarks(fractional)).toEqual(TABLE_TOPICS_MARKS);
		expect(formatTableTopicsTiming(fractional)).toBe(
			TABLE_TOPICS_DEFAULT_TIMING,
		);
	});

	it("rejects non-finite and negative values", () => {
		expect(
			hasTableTopicsLimits({ minSeconds: Number.NaN, maxSeconds: 150 }),
		).toBe(false);
		expect(
			hasTableTopicsLimits({
				minSeconds: 60,
				maxSeconds: Number.POSITIVE_INFINITY,
			}),
		).toBe(false);
		expect(hasTableTopicsLimits({ minSeconds: -60, maxSeconds: 150 })).toBe(
			false,
		);
	});

	it("accepts a zero minimum, which is a real limit and not absence", () => {
		expect(hasTableTopicsLimits({ minSeconds: 0, maxSeconds: 150 })).toBe(true);
	});

	it("refuses a window past the absolute ceiling", () => {
		// ABSOLUTE numbers on both sides, never `<= MAX_TABLE_TOPICS_SECONDS`,
		// which would pass for every value of the constant including one that
		// reintroduces the problem. 600s is the ceiling; 601 is out, 599 is in.
		expect(MAX_TABLE_TOPICS_SECONDS).toBe(600);
		expect(hasTableTopicsLimits({ minSeconds: 60, maxSeconds: 601 })).toBe(
			false,
		);
		expect(hasTableTopicsLimits({ minSeconds: 60, maxSeconds: 599 })).toBe(
			true,
		);
		// The realistic typo: a club meaning 2:30 and typing 230 seconds is still
		// under the ceiling and is NOT rejected — the ceiling catches digits, not
		// intent, and pretending otherwise would be a guess about what they meant.
		expect(hasTableTopicsLimits({ minSeconds: 60, maxSeconds: 230 })).toBe(
			true,
		);
	});

	it("falls back rather than rendering an over-ceiling row that already exists", () => {
		// A row written before the cap, or by a script, must not reach the Timer's
		// card — so the RENDER path falls back, not just the write path.
		const huge = { minSeconds: 60, maxSeconds: 99999 };
		expect(resolveTableTopicsMarks(huge)).toEqual(TABLE_TOPICS_MARKS);
		expect(formatTableTopicsTiming(huge)).toBe(TABLE_TOPICS_DEFAULT_TIMING);
	});
});

describe("resolveTableTopicsMarks", () => {
	it("falls back to the standard window when the club states nothing", () => {
		expect(resolveTableTopicsMarks(null)).toEqual(TABLE_TOPICS_MARKS);
		expect(
			resolveTableTopicsMarks({ minSeconds: null, maxSeconds: null }),
		).toEqual(TABLE_TOPICS_MARKS);
	});

	it("converts the club's seconds to minutes, with yellow at the midpoint", () => {
		// ABSOLUTE values, not "matches the formula" — the formula is the thing
		// under test. 60s/150s is MCF's window.
		expect(resolveTableTopicsMarks(MCF)).toEqual({
			green: 1,
			yellow: 1.75,
			red: 2.5,
		});
	});

	it("keeps the app-wide midpoint rule the existing constants already obey", () => {
		// `timing-window.ts` states "green = min, yellow = midpoint, red = max"
		// for every timed beat. Table Topics must not be the one segment whose
		// middle light means something else — so the DEFAULT window, expressed as
		// club limits, must reproduce the default marks exactly.
		expect(
			resolveTableTopicsMarks({ minSeconds: 60, maxSeconds: 120 }),
		).toEqual(TABLE_TOPICS_MARKS);
	});
});

describe("formatTableTopicsTiming", () => {
	it("falls back to the generic line when the club states nothing", () => {
		expect(formatTableTopicsTiming(null)).toBe(TABLE_TOPICS_DEFAULT_TIMING);
		expect(formatTableTopicsTiming({ minSeconds: 60, maxSeconds: null })).toBe(
			TABLE_TOPICS_DEFAULT_TIMING,
		);
	});

	it("states MCF's rule the way MCF's own agenda states it", () => {
		// The whole point of the issue: the projector must stop contradicting the
		// club's printed sheet.
		expect(formatTableTopicsTiming(MCF)).toBe(
			"1:00 minimum · 2:30 maximum · 2:31+ disqualified",
		);
	});

	it("derives the disqualifying second from the cap, so they cannot drift", () => {
		expect(formatTableTopicsTiming({ minSeconds: 30, maxSeconds: 119 })).toBe(
			"0:30 minimum · 1:59 maximum · 2:00+ disqualified",
		);
		// The carry at a minute boundary — the case a naive `${mins}:${secs+1}`
		// prints as "2:60".
		expect(formatTableTopicsTiming({ minSeconds: 60, maxSeconds: 179 })).toBe(
			"1:00 minimum · 2:59 maximum · 3:00+ disqualified",
		);
	});

	it("pads seconds so a clock never reads 2:5", () => {
		expect(formatTableTopicsTiming({ minSeconds: 65, maxSeconds: 125 })).toBe(
			"1:05 minimum · 2:05 maximum · 2:06+ disqualified",
		);
	});
});

describe("parseTableTopicsClock", () => {
	it("reads a clock", () => {
		expect(parseTableTopicsClock("2:30")).toBe(150);
		expect(parseTableTopicsClock("1:00")).toBe(60);
		expect(parseTableTopicsClock("0:05")).toBe(5);
		expect(parseTableTopicsClock(" 2:30 ")).toBe(150);
	});

	it("reads bare digits as seconds, above the unit-mistake floor", () => {
		expect(parseTableTopicsClock("90")).toBe(90);
		expect(parseTableTopicsClock("150")).toBe(150);
	});

	it("REFUSES a small bare number, which is minutes typed as seconds", () => {
		// The failure this closes: an admin thinking in MINUTES types 1 and 2.
		// Every downstream check passes — both set, max > min, integer, under the
		// ceiling — and the Timer's card prints green 0:01, red 0:02 while the
		// deck projects "0:01 minimum". A silent wrong number, arriving through
		// the branch an earlier comment called "unambiguous".
		expect(MIN_BARE_SECONDS).toBe(20);
		expect(parseTableTopicsClock("1")).toBeNull();
		expect(parseTableTopicsClock("2")).toBeNull();
		expect(parseTableTopicsClock("19")).toBeNull();
		// ABSOLUTE boundary, both sides.
		expect(parseTableTopicsClock("20")).toBe(20);
		// The CLOCK form is explicit about its units, so it is still honoured —
		// someone who writes 0:02 means two seconds.
		expect(parseTableTopicsClock("0:02")).toBe(2);
	});

	it("REFUSES a decimal, because 2.3 means 2:30 on the club's own sheet", () => {
		// Reading "2.3" as 2.3 minutes stores 2:18 — the silent rounding this
		// column is in seconds to avoid. Refusing makes the admin write the clock.
		expect(parseTableTopicsClock("2.3")).toBeNull();
		expect(parseTableTopicsClock("2.5")).toBeNull();
	});

	it("refuses nonsense and an out-of-range seconds field", () => {
		expect(parseTableTopicsClock("")).toBeNull();
		expect(parseTableTopicsClock("   ")).toBeNull();
		expect(parseTableTopicsClock("abc")).toBeNull();
		expect(parseTableTopicsClock("2:60")).toBeNull();
		expect(parseTableTopicsClock("2:5")).toBeNull();
		expect(parseTableTopicsClock("-30")).toBeNull();
	});

	it("round-trips with the formatter", () => {
		for (const seconds of [0, 5, 60, 90, 150, 599]) {
			expect(parseTableTopicsClock(formatTableTopicsClock(seconds))).toBe(
				seconds,
			);
		}
	});
});
