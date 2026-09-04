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
	refusalAfterEdit,
	refuseTableTopicsSeconds,
	resolveTableTopicsMarks,
	TABLE_TOPICS_DEFAULT_TIMING,
	TABLE_TOPICS_MESSAGES,
	tableTopicsClockText,
	validateTableTopicsForm,
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

// ---------------------------------------------------------------------------
// #679 — the admin form's validation, which was unreachable by any test.
//
// It lived inline in `club-settings.tsx`, a ROUTE file that cannot be mounted
// in vitest, so four branches and two initial-state expressions had no gate at
// all — and the ceiling check was missing for exactly as long as that was true,
// through a review of the very block whose comment promised it.
//
// Every boundary below is ABSOLUTE. Written as
// `expect(...(MAX_TABLE_TOPICS_SECONDS + 1)).ok === false` these would pass for
// every value of the constant, including one that reintroduces the problem —
// which is CLAUDE.md's relative-constant rule, and the reason the ceiling in
// particular is the worst assertion here to state relatively.
// ---------------------------------------------------------------------------
describe("refuseTableTopicsSeconds", () => {
	it("accepts a stated window, and the cleared state", () => {
		// The vacuity control: without it every refusal below could be produced by
		// a predicate that refuses everything.
		expect(refuseTableTopicsSeconds(60, 150)).toBeNull();
		expect(refuseTableTopicsSeconds(null, null)).toBeNull();
		// A zero minimum is a real (if silly) rule, not absence.
		expect(refuseTableTopicsSeconds(0, 150)).toBeNull();
	});

	it("refuses past the ceiling, on the bound that broke it", () => {
		expect(refuseTableTopicsSeconds(60, 600)).toBeNull();
		expect(refuseTableTopicsSeconds(60, 601)).toEqual({
			field: "max",
			message: TABLE_TOPICS_MESSAGES.tooLong,
		});
		expect(refuseTableTopicsSeconds(601, 700)).toEqual({
			field: "min",
			message: TABLE_TOPICS_MESSAGES.tooLong,
		});
	});

	it("refuses a half-stated window, pointing at the BLANK field", () => {
		// The field is the one to FILL, not the one carrying a value: an admin who
		// typed a maximum needs the cursor in the minimum.
		expect(refuseTableTopicsSeconds(60, null)).toEqual({
			field: "max",
			message: TABLE_TOPICS_MESSAGES.halfStated,
		});
		expect(refuseTableTopicsSeconds(null, 150)).toEqual({
			field: "min",
			message: TABLE_TOPICS_MESSAGES.halfStated,
		});
	});

	it("refuses an inverted or equal window", () => {
		expect(refuseTableTopicsSeconds(150, 60)).toEqual({
			field: "max",
			message: TABLE_TOPICS_MESSAGES.inverted,
		});
		expect(refuseTableTopicsSeconds(90, 90)).toEqual({
			field: "max",
			message: TABLE_TOPICS_MESSAGES.inverted,
		});
	});

	it("checks the ceiling BEFORE the cross-field rules", () => {
		// This function returns on the FIRST match, so its order alone decides
		// which sentence an input that breaks several rules gets — and BOTH layers
		// read that one answer. Do not restate this as "matches zod's
		// shape-then-refinement phases": that held while the ceiling was a
		// per-bound `.max()`, and #679 moved the ceiling in here, so zod has no
		// per-bound rule left to sequence against. The wiring guard separately
		// bans re-adding that `.max()`.
		expect(refuseTableTopicsSeconds(700, 601)?.message).toBe(
			TABLE_TOPICS_MESSAGES.tooLong,
		);
		// And an over-ceiling value that is ALSO half-stated.
		expect(refuseTableTopicsSeconds(null, 601)?.message).toBe(
			TABLE_TOPICS_MESSAGES.tooLong,
		);
	});
});

describe("validateTableTopicsForm", () => {
	it("passes MCF's window through as seconds", () => {
		expect(validateTableTopicsForm("1:00", "2:30")).toEqual({
			ok: true,
			minSeconds: 60,
			maxSeconds: 150,
		});
	});

	it("treats BLANK as clearing both columns, not as a zero", () => {
		// The distinction the columns depend on. `parseTableTopicsClock("")` is
		// also null, so the emptiness test cannot be folded into the parse — and
		// getting it wrong stores a 0:00 minimum instead of "no rule".
		expect(validateTableTopicsForm("", "")).toEqual({
			ok: true,
			minSeconds: null,
			maxSeconds: null,
		});
		expect(validateTableTopicsForm("   ", "  ")).toEqual({
			ok: true,
			minSeconds: null,
			maxSeconds: null,
		});
	});

	it("refuses an unparseable value on the field that holds it", () => {
		expect(validateTableTopicsForm("2.5", "2:30")).toEqual({
			ok: false,
			field: "min",
			message: TABLE_TOPICS_MESSAGES.unparseable,
		});
		expect(validateTableTopicsForm("1:00", "abc")).toEqual({
			ok: false,
			field: "max",
			message: TABLE_TOPICS_MESSAGES.unparseable,
		});
		// A bare number under the unit-mistake floor is unparseable, not a rule:
		// an admin thinking in MINUTES types 1 and 2.
		expect(validateTableTopicsForm("1", "2").ok).toBe(false);
	});

	it("refuses a half-stated window", () => {
		expect(validateTableTopicsForm("1:00", "")).toEqual({
			ok: false,
			field: "max",
			message: TABLE_TOPICS_MESSAGES.halfStated,
		});
		expect(validateTableTopicsForm("", "2:30")).toEqual({
			ok: false,
			field: "min",
			message: TABLE_TOPICS_MESSAGES.halfStated,
		});
	});

	it("refuses an inverted window", () => {
		expect(validateTableTopicsForm("2:30", "1:00")).toEqual({
			ok: false,
			field: "max",
			message: TABLE_TOPICS_MESSAGES.inverted,
		});
	});

	it("refuses past the ceiling — the branch the route was MISSING", () => {
		// This is the bug #679 named. `parseTableTopicsClock` accepts up to three
		// digits of minutes on purpose, so "20:00" parsed to 1200, passed
		// unparseable/half-stated/inverted, and returned from the server as a raw
		// zod message on a form that had already been submitted.
		expect(validateTableTopicsForm("1:00", "20:00")).toEqual({
			ok: false,
			field: "max",
			message: TABLE_TOPICS_MESSAGES.tooLong,
		});
		// ABSOLUTE, both sides of the boundary, through the FORM's own units.
		expect(validateTableTopicsForm("1:00", "10:00")).toEqual({
			ok: true,
			minSeconds: 60,
			maxSeconds: 600,
		});
		expect(validateTableTopicsForm("1:00", "601").ok).toBe(false);
		expect(validateTableTopicsForm("1:00", "599")).toEqual({
			ok: true,
			minSeconds: 60,
			maxSeconds: 599,
		});
		// The bare four-digit form the parser also accepts. "9999" is the shape the
		// issue named; it is 2:46:39, not a Table Topics answer.
		expect(validateTableTopicsForm("1:00", "9999")).toEqual({
			ok: false,
			field: "max",
			message: TABLE_TOPICS_MESSAGES.tooLong,
		});
	});

	it("refuses unparseable BEFORE the numeric rules", () => {
		// Both wrong: a garbage minimum and a maximum over the ceiling. The
		// unparseable field is the one the admin can actually see is wrong.
		expect(validateTableTopicsForm("abc", "20:00")).toEqual({
			ok: false,
			field: "min",
			message: TABLE_TOPICS_MESSAGES.unparseable,
		});
	});
});

describe("refusalAfterEdit", () => {
	const tooLongMax = {
		field: "max",
		message: TABLE_TOPICS_MESSAGES.tooLong,
	} as const;

	it("clears the marker when the FLAGGED field is edited", () => {
		expect(refusalAfterEdit(tooLongMax, "max")).toBeNull();
	});

	it("KEEPS a FIELD-scoped refusal when the other field is edited", () => {
		// The half an inline `prev?.field === field ? null : prev` gets wrong by
		// one operator, with the whole suite green. `unparseable` and `tooLong`
		// belong to ONE input, so dropping the red border on a still-broken
		// Minimum because the admin typed in Maximum tells them a field is fixed
		// when it is not.
		//
		// Asserted with `toBe`, not `toEqual`: `setTtRefusal` takes this as an
		// updater, so returning a fresh clone on every keystroke in the untouched
		// field would re-render the form for a value that did not change.
		expect(refusalAfterEdit(tooLongMax, "min")).toBe(tooLongMax);
		expect(
			refusalAfterEdit(
				{ field: "min", message: TABLE_TOPICS_MESSAGES.unparseable },
				"max",
			)?.message,
		).toBe(TABLE_TOPICS_MESSAGES.unparseable);
	});

	it("CLEARS a PAIR-scoped refusal from either field", () => {
		// `inverted` is attributed to `max`, but lowering the MINIMUM resolves it
		// — and leaving "The maximum must be longer than the minimum." standing
		// over a now-valid pair points `aria-describedby` at a false sentence.
		const inverted = {
			field: "max",
			message: TABLE_TOPICS_MESSAGES.inverted,
		} as const;
		expect(refusalAfterEdit(inverted, "max")).toBeNull();
		expect(refusalAfterEdit(inverted, "min")).toBeNull();

		// `halfStated` is attributed to the BLANK field, and clearing the FILLED
		// one is the legitimate "we state no window" resolution.
		const halfStated = {
			field: "max",
			message: TABLE_TOPICS_MESSAGES.halfStated,
		} as const;
		expect(refusalAfterEdit(halfStated, "min")).toBeNull();
		expect(refusalAfterEdit(halfStated, "max")).toBeNull();
	});

	it("is a no-op when nothing is flagged", () => {
		expect(refusalAfterEdit(null, "min")).toBeNull();
		expect(refusalAfterEdit(null, "max")).toBeNull();
	});
});

describe("tableTopicsClockText", () => {
	it("round-trips stored seconds back into the clock the admin typed", () => {
		expect(tableTopicsClockText(60)).toBe("1:00");
		expect(tableTopicsClockText(150)).toBe("2:30");
	});

	it("shows an EMPTY field for a column that is null, never 0:00", () => {
		// `formatTableTopicsClock(0)` is a perfectly good clock, so a `?? 0`
		// anywhere on this path turns "this club states no rule" into "this club's
		// minimum is zero seconds" on the screen — and the next save stores it.
		expect(tableTopicsClockText(null)).toBe("");
		// A stored ZERO is a real rule and must still render as a clock, which is
		// what makes the assertion above about null rather than about falsiness.
		expect(tableTopicsClockText(0)).toBe("0:00");
	});

	it("feeds its own output back through the validator unchanged", () => {
		// The two halves of the form are each other's inverse: what the page seeds
		// the inputs with must be what a save with no edit stores back. Without
		// this the seeding could format "2:30" as "2.5" and only the admin would
		// find out. 155s is deliberately odd-summed, the case the midpoint rounding
		// exists for.
		const stored = { minSeconds: 60, maxSeconds: 155 };
		expect(
			validateTableTopicsForm(
				tableTopicsClockText(stored.minSeconds),
				tableTopicsClockText(stored.maxSeconds),
			),
		).toEqual({ ok: true, ...stored });
		// And the cleared state round-trips to "clear both columns", not to a
		// half-window — the pair the form's blank/unparseable split turns on.
		expect(
			validateTableTopicsForm(
				tableTopicsClockText(null),
				tableTopicsClockText(null),
			),
		).toEqual({ ok: true, minSeconds: null, maxSeconds: null });
	});
});
