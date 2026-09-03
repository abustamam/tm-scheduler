import { describe, expect, it } from "vitest";
import { TABLE_TOPICS_MARKS } from "./agenda-runsheet";
import {
	formatTableTopicsClock,
	formatTableTopicsTiming,
	formatTableTopicsWindow,
	hasTableTopicsLimits,
	MAX_TABLE_TOPICS_SECONDS,
	MIN_BARE_SECONDS,
	parseTableTopicsClock,
	resolveTableTopicsMarks,
	TABLE_TOPICS_DEFAULT_TIMING,
} from "./table-topics-limits";
import { formatTimingClock } from "./timing-window";

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

	// -----------------------------------------------------------------------
	// The midpoint is rounded to a WHOLE SECOND, and that is a correctness fix.
	//
	// `mark_yellow` is `real()` — float4 — so a materialised template stores the
	// midpoint at ~7 significant digits while every unmaterialised surface
	// re-derives it as a float64. An odd-summed window puts the midpoint on a
	// half second, and `formatTimingClock`'s `Math.round` then breaks the tie
	// from the wrong side of the float4 noise.
	// -----------------------------------------------------------------------
	describe("the midpoint survives being stored as float4", () => {
		it("rounds to a whole second before converting to minutes", () => {
			// (60 + 155) / 2 = 107.5s, which rounds UP to 108s = 1.8 min exactly.
			// ABSOLUTE — `(green + red) / 2` would give 1.7916666666666667 here and
			// pass any assertion written against the formula.
			expect(
				resolveTableTopicsMarks({ minSeconds: 60, maxSeconds: 155 }).yellow,
			).toBe(1.8);
		});

		it("PRE-FIX CONTROL: the unrounded midpoint really does drift", () => {
			// Without this the suite below could be passing for a reason unrelated
			// to the fix. `Math.fround` is what Postgres does to a `real` column.
			const unrounded = (60 / 60 + 155 / 60) / 2;
			expect(formatTimingClock(unrounded)).toBe("1:48");
			expect(formatTimingClock(Math.fround(unrounded))).toBe("1:47");
		});

		it("agrees with itself across every window a club can state", () => {
			// The frozen copy and the live derivation must print the same clock, or
			// one meeting's Timer signals a second before the next one's for a
			// reason nobody in the room can see.
			let odd = 0;
			for (let min = 20; min <= 240; min += 5) {
				for (let max = min + 1; max <= 300; max += 7) {
					const { yellow } = resolveTableTopicsMarks({
						minSeconds: min,
						maxSeconds: max,
					});
					if ((min + max) % 2 === 1) odd++;
					expect(
						formatTimingClock(Math.fround(yellow)),
						`${min}s–${max}s`,
					).toBe(formatTimingClock(yellow));
				}
			}
			// The control's control: a sweep that happened to contain no
			// odd-summed window would pass with the rounding deleted.
			expect(odd).toBeGreaterThan(100);
		});
	});
});

describe("formatTableTopicsWindow", () => {
	it("states the club's own window, with no ±30s speech grace", () => {
		// ABSOLUTE. This is what the templated deck projects and what the Timer's
		// role sheet prints, and the graced form of the same window — "0:30–3:00"
		// — is what both said before #443's second cut.
		expect(formatTableTopicsWindow(resolveTableTopicsMarks(MCF))).toBe(
			"1:00–2:30",
		);
		expect(formatTableTopicsWindow(TABLE_TOPICS_MARKS)).toBe("1:00–2:00");
	});

	it("names the same two numbers the deck's sentence names", () => {
		// The two surfaces state one rule in two shapes. Pinned together so
		// whoever changes one gets a failure naming the other.
		expect(formatTableTopicsTiming(MCF)).toContain("1:00 minimum");
		expect(formatTableTopicsTiming(MCF)).toContain("2:30 maximum");
		expect(formatTableTopicsWindow(resolveTableTopicsMarks(MCF))).toBe(
			"1:00–2:30",
		);
	});
});

describe("TABLE_TOPICS_DEFAULT_TIMING", () => {
	it("states the same window TABLE_TOPICS_MARKS signals", () => {
		// Proximity was the only thing holding these together: nothing derived the
		// sentence from the marks and no test compared them, so changing the marks
		// to 1/1.5/2.5 left the deck projecting "1–2 minutes" with every gate
		// green. ABSOLUTE on both sides.
		expect(TABLE_TOPICS_DEFAULT_TIMING).toBe("1–2 minutes per speaker");
		expect(TABLE_TOPICS_MARKS.green).toBe(1);
		expect(TABLE_TOPICS_MARKS.red).toBe(2);
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
