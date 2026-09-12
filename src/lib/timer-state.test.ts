/**
 * The stopwatch reducer (#729).
 *
 * Every action carries its own `now`, so these assert INSTANTS rather than
 * sleeping — a test that starts a clock, waits, and asserts "about six seconds"
 * proves nothing about the boundary the Timer actually cares about.
 *
 * The no-op cases carry the weight here. A reducer that restarted on a second
 * `start` passes every "does it count up?" assertion and silently drops the
 * seconds already run, which on this surface is a speech measured short.
 */
import { describe, expect, it } from "vitest";
import {
	elapsedMs,
	elapsedSeconds,
	formatStopwatch,
	IDLE_TIMER,
	parseStopwatch,
	type TimerState,
	timerReducer,
} from "./timer-state";

const T0 = 1_700_000_000_000;

/** Apply a sequence of actions from idle, so a test reads as the taps a Timer
 *  makes rather than as nested reducer calls. */
const run = (...actions: Parameters<typeof timerReducer>[1][]): TimerState =>
	actions.reduce(timerReducer, IDLE_TIMER);

describe("phase transitions", () => {
	it("starts from idle, opening an interval and banking nothing", () => {
		const s = run({ type: "start", now: T0 });
		expect(s.phase).toBe("running");
		expect(s.accumulatedMs).toBe(0);
		expect(s.startedAt).toBe(T0);
	});

	it("pauses from running, banking the open interval and closing it", () => {
		const s = run(
			{ type: "start", now: T0 },
			{ type: "pause", now: T0 + 6000 },
		);
		expect(s.phase).toBe("paused");
		expect(s.accumulatedMs).toBe(6000);
		// The whole point of the two-field shape: the banked total never carries
		// an open interval, so nothing can double-count it on the next read.
		expect(s.startedAt).toBeNull();
	});

	it("resumes from paused, opening a NEW interval on top of what is banked", () => {
		const s = run(
			{ type: "start", now: T0 },
			{ type: "pause", now: T0 + 6000 },
			{ type: "resume", now: T0 + 20_000 },
		);
		expect(s.phase).toBe("running");
		expect(s.accumulatedMs).toBe(6000);
		expect(s.startedAt).toBe(T0 + 20_000);
	});

	it("stops from running", () => {
		const s = run({ type: "start", now: T0 }, { type: "stop", now: T0 + 9000 });
		expect(s.phase).toBe("stopped");
		expect(s.accumulatedMs).toBe(9000);
		expect(s.startedAt).toBeNull();
	});

	it("stops from paused, keeping the banked total unchanged", () => {
		const s = run(
			{ type: "start", now: T0 },
			{ type: "pause", now: T0 + 6000 },
			{ type: "stop", now: T0 + 60_000 },
		);
		expect(s.phase).toBe("stopped");
		// The 54s spent paused is NOT part of the measurement.
		expect(s.accumulatedMs).toBe(6000);
	});

	it("resets to idle from running — the mis-started-row escape hatch", () => {
		const s = run({ type: "start", now: T0 }, { type: "reset" });
		expect(s).toEqual({ phase: "idle", accumulatedMs: 0, startedAt: null });
	});

	it("resets to idle from stopped", () => {
		const s = run(
			{ type: "start", now: T0 },
			{ type: "stop", now: T0 + 9000 },
			{ type: "reset" },
		);
		expect(s).toEqual({ phase: "idle", accumulatedMs: 0, startedAt: null });
	});
});

describe("the no-ops, which are what a mis-tap costs", () => {
	it("a second start while running does NOT restart the clock", () => {
		// The bug this rules out: re-opening `startedAt` at the second tap drops
		// every second already run, and the speech is recorded short.
		const running = run({ type: "start", now: T0 });
		const again = timerReducer(running, { type: "start", now: T0 + 5000 });
		expect(again).toBe(running);
		expect(elapsedMs(again, T0 + 10_000)).toBe(10_000);
	});

	it("start while paused is ignored — resume is the action for that", () => {
		const paused = run(
			{ type: "start", now: T0 },
			{ type: "pause", now: T0 + 6000 },
		);
		expect(timerReducer(paused, { type: "start", now: T0 + 7000 })).toBe(
			paused,
		);
	});

	it("start while stopped is ignored — a finished measurement needs a reset", () => {
		const stopped = run(
			{ type: "start", now: T0 },
			{ type: "stop", now: T0 + 9000 },
		);
		expect(timerReducer(stopped, { type: "start", now: T0 + 10_000 })).toBe(
			stopped,
		);
	});

	it("pause while paused is ignored", () => {
		const paused = run(
			{ type: "start", now: T0 },
			{ type: "pause", now: T0 + 6000 },
		);
		const again = timerReducer(paused, { type: "pause", now: T0 + 30_000 });
		expect(again).toBe(paused);
		expect(again.accumulatedMs).toBe(6000);
	});

	it("pause from idle is ignored", () => {
		expect(timerReducer(IDLE_TIMER, { type: "pause", now: T0 })).toBe(
			IDLE_TIMER,
		);
	});

	it("resume while running is ignored — it would reopen the interval", () => {
		const running = run({ type: "start", now: T0 });
		expect(timerReducer(running, { type: "resume", now: T0 + 5000 })).toBe(
			running,
		);
	});

	it("resume from stopped is ignored — a recorded measurement cannot grow", () => {
		// #730 records a STOP. A clock that could be resumed afterwards would let
		// the surface show a number the stored row no longer matches.
		const stopped = run(
			{ type: "start", now: T0 },
			{ type: "stop", now: T0 + 9000 },
		);
		expect(timerReducer(stopped, { type: "resume", now: T0 + 10_000 })).toBe(
			stopped,
		);
	});

	it("stop from idle is ignored — there is no zero-second speech to record", () => {
		expect(timerReducer(IDLE_TIMER, { type: "stop", now: T0 })).toBe(
			IDLE_TIMER,
		);
	});

	it("stop while stopped is ignored", () => {
		const stopped = run(
			{ type: "start", now: T0 },
			{ type: "stop", now: T0 + 9000 },
		);
		expect(timerReducer(stopped, { type: "stop", now: T0 + 99_000 })).toBe(
			stopped,
		);
	});
});

describe("elapsedMs", () => {
	it("is zero on an idle clock at any instant", () => {
		expect(elapsedMs(IDLE_TIMER, T0 + 999_999)).toBe(0);
	});

	it("includes the open interval while running", () => {
		const s = run({ type: "start", now: T0 });
		expect(elapsedMs(s, T0)).toBe(0);
		expect(elapsedMs(s, T0 + 1234)).toBe(1234);
	});

	it("is frozen while paused, however long the pause lasts", () => {
		const s = run(
			{ type: "start", now: T0 },
			{ type: "pause", now: T0 + 6000 },
		);
		expect(elapsedMs(s, T0 + 6000)).toBe(6000);
		expect(elapsedMs(s, T0 + 600_000)).toBe(6000);
	});

	it("is monotonic across a pause/resume cycle", () => {
		// The property the two-field shape exists for: the reading never goes
		// BACKWARDS across a cycle, and the paused span is excluded from it.
		const started = run({ type: "start", now: T0 });
		const paused = timerReducer(started, { type: "pause", now: T0 + 6000 });
		const resumed = timerReducer(paused, { type: "resume", now: T0 + 30_000 });
		const readings = [
			elapsedMs(started, T0 + 3000),
			elapsedMs(started, T0 + 6000),
			elapsedMs(paused, T0 + 15_000),
			elapsedMs(paused, T0 + 30_000),
			elapsedMs(resumed, T0 + 30_000),
			elapsedMs(resumed, T0 + 33_000),
		];
		expect(readings).toEqual([3000, 6000, 6000, 6000, 6000, 9000]);
		for (let i = 1; i < readings.length; i++) {
			expect(readings[i]).toBeGreaterThanOrEqual(readings[i - 1]);
		}
	});

	it("never goes backwards when the wall clock does", () => {
		// `now` is `Date.now()`, which an NTP correction can move backwards
		// mid-speech. A negative interval would subtract from a measurement.
		const s = run({ type: "start", now: T0 });
		expect(elapsedMs(s, T0 - 5000)).toBe(0);
	});

	it("holds the final reading after a stop", () => {
		const s = run({ type: "start", now: T0 }, { type: "stop", now: T0 + 9000 });
		expect(elapsedMs(s, T0 + 900_000)).toBe(9000);
	});
});

describe("elapsedSeconds — the unit the record stores", () => {
	it("rounds to the nearest whole second", () => {
		const at = (ms: number) =>
			elapsedSeconds(
				run({ type: "start", now: T0 }, { type: "stop", now: T0 + ms }),
				T0 + ms,
			);
		expect(at(6499)).toBe(6);
		expect(at(6500)).toBe(7);
		expect(at(371_000)).toBe(371);
	});
});

describe("formatStopwatch", () => {
	it("pads the seconds and never wraps the minutes at 60", () => {
		expect(formatStopwatch(0)).toBe("0:00");
		expect(formatStopwatch(9_000)).toBe("0:09");
		expect(formatStopwatch(371_000)).toBe("6:11");
		expect(formatStopwatch(3_780_000)).toBe("63:00");
	});

	it("truncates rather than rounding, so the display never shows a second early", () => {
		expect(formatStopwatch(6_999)).toBe("0:06");
	});

	it("clamps a negative input at zero", () => {
		expect(formatStopwatch(-1)).toBe("0:00");
	});
});

describe("parseStopwatch — the officer's correction input", () => {
	it("round-trips every value formatStopwatch can print", () => {
		for (const seconds of [0, 6, 59, 60, 371, 3780]) {
			expect(parseStopwatch(formatStopwatch(seconds * 1000))).toBe(seconds);
		}
	});

	it("accepts a clock with or without a leading zero, and tolerates padding", () => {
		expect(parseStopwatch("6:11")).toBe(371);
		expect(parseStopwatch("06:11")).toBe(371);
		expect(parseStopwatch("  6:11  ")).toBe(371);
		expect(parseStopwatch("0:06")).toBe(6);
	});

	it("does not wrap minutes at 60", () => {
		expect(parseStopwatch("63:00")).toBe(3780);
	});

	it("REFUSES a bare number, which is the unit trap", () => {
		// `parseTableTopicsClock` accepts bare digits above a floor because no
		// club's speaking LIMIT is under twenty seconds. A measured time can be,
		// so the same leniency here would read an officer typing "6" as six
		// SECONDS and store it with every downstream check passing.
		for (const text of ["6", "371", "0"]) {
			expect(parseStopwatch(text), text).toBeNull();
		}
	});

	it("refuses a seconds field of 60 or more — a typo, not 7:15", () => {
		expect(parseStopwatch("6:75")).toBeNull();
		expect(parseStopwatch("6:60")).toBeNull();
	});

	it("refuses blanks, decimals and anything else", () => {
		for (const text of ["", "   ", "6.5", "6:5", "six", "-1:00", "6:1x"]) {
			expect(parseStopwatch(text), JSON.stringify(text)).toBeNull();
		}
	});
});
