import { describe, expect, it } from "vitest";
import {
	firstQualifyingWindow,
	formatTimingClock,
	graceNote,
	graceRuleSentence,
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

	it("labels a window with the segment it was derived for", () => {
		expect(qualifyingWindow(5, 7)?.segment).toBe("speech");
		expect(qualifyingWindow(1, 2, "tableTopics")?.segment).toBe("tableTopics");
	});
});

// #720 — a Table Topics response must REACH the minimum to be eligible for Best
// Table Topics, so the grace applies above red only. Every expected value here
// is an ABSOLUTE clock: stated as `green - TIMING_GRACE_MINUTES` these would
// pass for the rule they exist to forbid.
describe("qualifyingWindow for Table Topics (#720)", () => {
	it("floors at green with the default 1:00–2:00 marks", () => {
		const w = qualifyingWindow(1, 2, "tableTopics");
		expect(w?.fromMinutes).toBe(1);
		expect(w?.toMinutes).toBe(2.5);
		expect(w?.range).toBe("1:00–2:30");
		// The bug, named so the assertion above cannot pass by coincidence.
		expect(w?.range).not.toBe("0:30–2:30");
	});

	it("floors at the CLUB's green, not at ours", () => {
		// A club that deliberately states a 0:45 minimum gets 0:45 — the floor is
		// whatever green the club set, not a house number. (#720 explicitly
		// declined to raise the stored CHECK floor to 60 s.)
		expect(qualifyingWindow(0.75, 2.5, "tableTopics")?.range).toBe("0:45–3:00");
		expect(qualifyingWindow(1, 2.5, "tableTopics")?.range).toBe("1:00–3:00");
	});

	it("keeps the UPPER grace, which #720 leaves alone", () => {
		const w = qualifyingWindow(1, 2, "tableTopics");
		expect(w?.to).toBe("2:30");
		expect(w?.toMinutes).toBe(2.5);
	});

	it("leaves speeches and evaluations exactly as they were", () => {
		// The regression pin. Dropping the lower grace unconditionally would look
		// identical to dropping it for one segment, on every surface but these.
		expect(qualifyingWindow(5, 7, "speech")?.range).toBe("4:30–7:30");
		expect(qualifyingWindow(2, 3, "speech")?.range).toBe("1:30–3:30");
		// …and the default argument is the speech rule, so an un-migrated call
		// site cannot silently pick up the Table Topics floor.
		expect(qualifyingWindow(5, 7)?.range).toBe("4:30–7:30");
		expect(
			qualifyingWindowForMarks({ green: 2, yellow: 2.5, red: 3 })?.range,
		).toBe("1:30–3:30");
	});

	it("still clamps at zero rather than rendering a negative clock", () => {
		// Vacuous for Table Topics as such (a floor at green cannot go below
		// zero), but the clamp is a property of the function and #720's AC 6 asks
		// for it to hold across both variants.
		expect(qualifyingWindow(0, 1, "tableTopics")?.from).toBe("0:00");
		expect(qualifyingWindow(0.25, 1, "speech")?.from).toBe("0:00");
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

	it("carries the segment through to the marks form (#720)", () => {
		expect(
			qualifyingWindowForMarks({ green: 1, yellow: 1.5, red: 2 }, "tableTopics")
				?.range,
		).toBe("1:00–2:30");
	});
});

describe("firstQualifyingWindow teaches a SPEECH window (#507)", () => {
	// #507 gave evaluations and Table Topics marks. Before it, "first marked
	// row" and "first speech" were the same row, and the printed grace line
	// silently started teaching "e.g. a 1:00–2:00 speech" — the Table Topics
	// window — to any club whose speakers carry no min/max, which is the default.
	it("skips non-speaker marked rows", () => {
		const w = firstQualifyingWindow([
			{
				roleKey: "table_topics_master",
				marks: { green: 1, yellow: 1.5, red: 2 },
			},
			{ roleKey: "evaluator", marks: { green: 2, yellow: 2.5, red: 3 } },
			{ roleKey: "speaker", marks: { green: 5, yellow: 6, red: 7 } },
		]);
		expect(w?.assigned).toBe("5:00–7:00");
	});

	it("states the bare rule when no SPEECH has a window", () => {
		// The club runs Table Topics and evaluations but nobody typed a speech
		// range. Teaching a number here would teach the wrong one.
		expect(
			firstQualifyingWindow([
				{
					roleKey: "table_topics_master",
					marks: { green: 1, yellow: 1.5, red: 2 },
				},
				{ roleKey: "speaker", marks: null },
			]),
		).toBeNull();
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

	// #720 AC 4: the WORDS have to follow the NUMBERS. Both of these read the
	// window's own `segment`, so a surface cannot print "0:30 before green" over
	// a window that starts at green.
	it("states the Table Topics rule over a Table Topics window", () => {
		const w = qualifyingWindow(1, 2, "tableTopics");
		expect(graceNote(w)).toBe(
			"+0:30 grace — e.g. a 1:00–2:00 Table Topics response qualifies 1:00–2:30",
		);
		expect(graceNote(w)).not.toContain("±0:30");
		expect(graceSentence(w)).toBe(
			"A Table Topics response qualifies from green through 0:30 after red — a 1:00–2:00 Table Topics response qualifies between 1:00 and 2:30.",
		);
		expect(graceSentence(w)).not.toContain("0:30 before green");
	});

	it("keeps the speech copy byte-identical over a speech window", () => {
		// The other half of the pairing: adding the segment must not reword the
		// four surfaces that were already right.
		const w = qualifyingWindow(4, 6);
		expect(graceNote(w)).toBe(
			"±0:30 grace — e.g. a 4:00–6:00 speech qualifies 3:30–6:30",
		);
		expect(graceSentence(w)).toBe(
			"A speech qualifies from 0:30 before green through 0:30 after red — a 4:00–6:00 speech qualifies between 3:30 and 6:30.",
		);
	});
});

// The standalone-rule form the Timer's sheet reads, where ONE note sits under a
// table holding both kinds of row (#720).
describe("graceRuleSentence", () => {
	it("states each segment's rule as its own sentence", () => {
		expect(graceRuleSentence("speech")).toBe(
			"A speech qualifies from 0:30 before green through 0:30 after red.",
		);
		expect(graceRuleSentence("tableTopics")).toBe(
			"A Table Topics response qualifies from green through 0:30 after red.",
		);
	});

	it("is the same rule `graceSentence` states for a window of that segment", () => {
		// One source, two shapes. If these drift, one surface teaches a rule the
		// next contradicts — which is the whole of #720.
		expect(graceSentence(null)).toBe(graceRuleSentence("speech"));
		for (const segment of ["speech", "tableTopics"] as const) {
			const w = qualifyingWindow(1, 2, segment);
			expect(w).not.toBeNull();
			expect(graceSentence(w)).toContain(
				graceRuleSentence(segment).replace(/\.$/, ""),
			);
		}
	});
});
