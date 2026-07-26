import { describe, expect, it } from "vitest";
import {
	DEFAULT_SPEAKER_MINUTES,
	SPEECH_WINDOW_HALF_PAIR_MESSAGE,
	SPEECH_WINDOW_ORDER_MESSAGE,
	speechBookedMinutes,
	speechWindow,
	speechWindowInputError,
} from "./speech-window";

describe("speechWindow (#394)", () => {
	it("returns the range when both ends are set", () => {
		expect(speechWindow({ minMinutes: 5, maxMinutes: 7 })).toEqual({
			min: 5,
			max: 7,
		});
	});

	it("accepts a single-value range (min === max)", () => {
		expect(speechWindow({ minMinutes: 7, maxMinutes: 7 })).toEqual({
			min: 7,
			max: 7,
		});
	});

	it("is null for a min with no max — the case that read three ways", () => {
		expect(speechWindow({ minMinutes: 5, maxMinutes: null })).toBeNull();
		expect(speechWindow({ minMinutes: 5 })).toBeNull();
	});

	it("is null for a max with no min", () => {
		expect(speechWindow({ minMinutes: null, maxMinutes: 7 })).toBeNull();
		expect(speechWindow({ maxMinutes: 7 })).toBeNull();
	});

	it("is null when neither end is set", () => {
		expect(speechWindow({ minMinutes: null, maxMinutes: null })).toBeNull();
		expect(speechWindow({})).toBeNull();
		expect(speechWindow(null)).toBeNull();
		expect(speechWindow(undefined)).toBeNull();
	});

	it("is null when min is above max — an inverted pair is not a window", () => {
		expect(speechWindow({ minMinutes: 7, maxMinutes: 5 })).toBeNull();
	});

	it("is null for non-finite values", () => {
		expect(speechWindow({ minMinutes: Number.NaN, maxMinutes: 7 })).toBeNull();
		expect(
			speechWindow({ minMinutes: 5, maxMinutes: Number.POSITIVE_INFINITY }),
		).toBeNull();
	});

	it("never invents the missing bound", () => {
		// A half-pair has no RANGE, and is not a range derived from the one value
		// the club did type. Anything non-null here would be an edge nobody
		// entered, signalled at as though they had.
		for (const input of [
			{ minMinutes: 5, maxMinutes: null },
			{ minMinutes: null, maxMinutes: 7 },
		]) {
			expect(speechWindow(input)).toBeNull();
		}
	});
});

describe("speechBookedMinutes (#394)", () => {
	it("books the maximum when the slot has one", () => {
		expect(speechBookedMinutes({ minMinutes: 5, maxMinutes: 7 })).toBe(7);
	});

	it("books a max that has no min — the club typed it, it stands", () => {
		// The case that keeps this separate from `speechWindow`: no range to
		// display, but an unambiguous allowance. Defaulting here would reserve
		// more of the meeting than the club asked for.
		expect(speechBookedMinutes({ minMinutes: null, maxMinutes: 6 })).toBe(6);
		expect(speechWindow({ minMinutes: null, maxMinutes: 6 })).toBeNull();
	});

	it("books the max of an inverted pair, which is still a stated allowance", () => {
		expect(speechBookedMinutes({ minMinutes: 9, maxMinutes: 4 })).toBe(4);
	});

	it("falls back to the default when there is no maximum", () => {
		// A minimum is not an allowance — this was the reported bug, where the
		// deck projected the min as though it were the whole slot.
		expect(speechBookedMinutes({ minMinutes: 5, maxMinutes: null })).toBe(
			DEFAULT_SPEAKER_MINUTES,
		);
		expect(speechBookedMinutes({})).toBe(DEFAULT_SPEAKER_MINUTES);
		expect(speechBookedMinutes(null)).toBe(DEFAULT_SPEAKER_MINUTES);
		expect(speechBookedMinutes(undefined)).toBe(DEFAULT_SPEAKER_MINUTES);
	});

	it("falls back to the default for a non-finite maximum", () => {
		expect(speechBookedMinutes({ maxMinutes: Number.NaN })).toBe(
			DEFAULT_SPEAKER_MINUTES,
		);
	});

	it("is the top of the window whenever there is a window", () => {
		// The two helpers must never contradict each other on a fully configured
		// slot: that equality is what lets the deck print a range and the run
		// sheet book a single number without the two drifting.
		for (const input of [
			{ minMinutes: 4, maxMinutes: 6 },
			{ minMinutes: 5, maxMinutes: 7 },
			{ minMinutes: 7, maxMinutes: 7 },
		]) {
			expect(speechBookedMinutes(input)).toBe(speechWindow(input)?.max);
		}
	});
});

describe("speechWindowInputError (#394)", () => {
	it("accepts both ends set", () => {
		expect(speechWindowInputError(5, 7)).toBeNull();
		expect(speechWindowInputError(7, 7)).toBeNull();
	});

	it("accepts neither end set", () => {
		expect(speechWindowInputError(undefined, undefined)).toBeNull();
		expect(speechWindowInputError(null, null)).toBeNull();
	});

	it("rejects a min with no max", () => {
		expect(speechWindowInputError(5, undefined)).toBe(
			SPEECH_WINDOW_HALF_PAIR_MESSAGE,
		);
		expect(speechWindowInputError(5, null)).toBe(
			SPEECH_WINDOW_HALF_PAIR_MESSAGE,
		);
	});

	it("rejects a max with no min", () => {
		expect(speechWindowInputError(undefined, 7)).toBe(
			SPEECH_WINDOW_HALF_PAIR_MESSAGE,
		);
	});

	it("rejects min above max, with its own message", () => {
		expect(speechWindowInputError(7, 5)).toBe(SPEECH_WINDOW_ORDER_MESSAGE);
	});

	it("agrees with the read side: anything it accepts either has a window or has neither end", () => {
		const values = [undefined, null, 4, 5, 7];
		for (const minMinutes of values) {
			for (const maxMinutes of values) {
				if (speechWindowInputError(minMinutes, maxMinutes) !== null) continue;
				const w = speechWindow({ minMinutes, maxMinutes });
				const blank = minMinutes == null && maxMinutes == null;
				expect(blank ? w === null : w !== null).toBe(true);
			}
		}
	});
});
