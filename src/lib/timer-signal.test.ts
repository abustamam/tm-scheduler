/**
 * The live card colour (#729).
 *
 * These are BOUNDARY INSTANTS, not samples. A test that asserts "green"
 * somewhere in the middle of the window passes for a rule that is off by
 * thirty seconds at either end, which is the whole thing the Timer is watching
 * for — so every case here sits exactly on a transition, one millisecond below
 * it, or one millisecond above.
 *
 * The two DQ rules are asserted SEPARATELY and against each other. Conflating
 * them is the failure `agenda-template-slides.ts` records, so it is not enough
 * to prove Table Topics disqualifies at its cap: the same fixture has to prove
 * it does NOT wait for the speech grace.
 */
import { describe, expect, it } from "vitest";
import type { TimingMarks } from "./agenda-runsheet";
import { tableTopicsDqSeconds } from "./table-topics-limits";
import { TIMER_BAND_LABEL, timerSignal } from "./timer-signal";
import { TIMING_GRACE_MINUTES } from "./timing-window";

/** A standard 5–7 speech: green 5:00, yellow 6:00, red 7:00. */
const SPEECH: TimingMarks = { green: 5, yellow: 6, red: 7 };
const MIN = 60_000;

describe("kind: speech", () => {
	it("is under before green, and green AT green", () => {
		expect(timerSignal(5 * MIN - 1, SPEECH, "speech")).toBe("under");
		expect(timerSignal(5 * MIN, SPEECH, "speech")).toBe("green");
	});

	it("is green until yellow, and yellow AT yellow", () => {
		expect(timerSignal(6 * MIN - 1, SPEECH, "speech")).toBe("green");
		expect(timerSignal(6 * MIN, SPEECH, "speech")).toBe("yellow");
	});

	it("is yellow until red, and red AT red", () => {
		expect(timerSignal(7 * MIN - 1, SPEECH, "speech")).toBe("yellow");
		expect(timerSignal(7 * MIN, SPEECH, "speech")).toBe("red");
	});

	it("stays red THROUGH the grace instant, and goes over strictly after it", () => {
		// "A speech qualifies from 0:30 before green through 0:30 after red"
		// (#357). `through` is inclusive, so 7:30 exactly is still inside the
		// window and still the red card — not over.
		const grace = (7 + TIMING_GRACE_MINUTES) * MIN;
		expect(timerSignal(grace - 1, SPEECH, "speech")).toBe("red");
		expect(timerSignal(grace, SPEECH, "speech")).toBe("red");
		expect(timerSignal(grace + 1, SPEECH, "speech")).toBe("over");
	});

	it("reads the grace from timing-window rather than a restated 0.5", () => {
		// Pins the SOURCE, not the number: a hardcoded 30s here would keep every
		// assertion above green while the club's printed sheet moved.
		const grace = (7 + TIMING_GRACE_MINUTES) * MIN;
		expect(grace).toBe(7.5 * MIN);
	});

	it("is under at every instant when the row carries no marks", () => {
		for (const at of [0, 5 * MIN, 60 * MIN]) {
			expect(timerSignal(at, null, "speech")).toBe("under");
			expect(timerSignal(at, undefined, "speech")).toBe("under");
		}
	});

	it("ignores a limits argument entirely", () => {
		// A caller that passed the club's Table Topics window to a SPEECH row
		// must not have that window applied — the speech grace is the rule.
		expect(timerSignal(8 * MIN, SPEECH, "speech", { maxSeconds: 150 })).toBe(
			"over",
		);
		expect(timerSignal(7 * MIN, SPEECH, "speech", { maxSeconds: 150 })).toBe(
			"red",
		);
	});

	it("handles a sub-grace window without inventing a negative boundary", () => {
		// A 1–2 minute Ice Breaker style row: red + grace is 2:30, well above
		// zero, but the green edge sits below the grace and must not underflow.
		const short: TimingMarks = { green: 1, yellow: 1.5, red: 2 };
		expect(timerSignal(0, short, "speech")).toBe("under");
		expect(timerSignal(2.5 * MIN, short, "speech")).toBe("red");
		expect(timerSignal(2.5 * MIN + 1, short, "speech")).toBe("over");
	});
});

describe("kind: tableTopics", () => {
	/** A club stating 60s–150s: `resolveTableTopicsMarks` puts red at the cap. */
	const LIMITS = { minSeconds: 60, maxSeconds: 150 };
	const TT: TimingMarks = { green: 1, yellow: 1.75, red: 2.5 };

	it("goes over AT the first disqualifying second, not one later", () => {
		const dq = tableTopicsDqSeconds(LIMITS) * 1000;
		expect(dq).toBe(151_000);
		expect(timerSignal(dq - 1, TT, "tableTopics", LIMITS)).toBe("red");
		expect(timerSignal(dq, TT, "tableTopics", LIMITS)).toBe("over");
	});

	it("does NOT wait for the speech grace — the rules are different rules", () => {
		// The failure this exists to rule out: at 2:45 a 2:30-cap club's answer is
		// disqualified, and the speech rule would still call it red.
		const at = 165_000; // 2:45
		expect(timerSignal(at, TT, "tableTopics", LIMITS)).toBe("over");
		expect(at).toBeLessThan((TT.red + TIMING_GRACE_MINUTES) * MIN);
		expect(timerSignal(at, TT, "speech")).toBe("red");
	});

	it("shows the same green/yellow/red ladder below the cap", () => {
		expect(timerSignal(59_999, TT, "tableTopics", LIMITS)).toBe("under");
		expect(timerSignal(60_000, TT, "tableTopics", LIMITS)).toBe("green");
		expect(timerSignal(105_000, TT, "tableTopics", LIMITS)).toBe("yellow");
		expect(timerSignal(150_000, TT, "tableTopics", LIMITS)).toBe("red");
	});

	it("never reaches over when the club has stated no window", () => {
		// `hasTableTopicsLimits` is what decides that a club HAS a window; with
		// none there is no disqualification point to apply, and guessing one
		// would enforce a rule the club never stated.
		for (const at of [150_000, 600_000, 3_600_000]) {
			expect(timerSignal(at, TT, "tableTopics", null)).toBe("red");
			expect(timerSignal(at, TT, "tableTopics")).toBe("red");
		}
	});

	it("is under at every instant when the row carries no marks", () => {
		expect(timerSignal(600_000, null, "tableTopics", LIMITS)).toBe("under");
	});
});

describe("TIMER_BAND_LABEL", () => {
	it("names every band, so a new one cannot render blank", () => {
		expect(Object.keys(TIMER_BAND_LABEL).sort()).toEqual([
			"green",
			"over",
			"red",
			"under",
			"yellow",
		]);
		for (const label of Object.values(TIMER_BAND_LABEL)) {
			expect(label.trim()).not.toBe("");
		}
	});
});
