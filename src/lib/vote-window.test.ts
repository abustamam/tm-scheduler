import { describe, expect, it } from "vitest";
import {
	autoVoteWindow,
	isInAutoVoteWindow,
	VOTE_GRACE_AFTER_MS,
} from "./vote-window";

const START = new Date("2026-10-31T19:00:00.000Z");

describe("autoVoteWindow", () => {
	// protects=the window opens exactly at the scheduled start; fails_when=a
	// grace-before or an off-by-one opens it early or a millisecond late;
	// no_claim=none beyond protects
	it("is inclusive at its start", () => {
		const w = autoVoteWindow(START, 90);
		expect(isInAutoVoteWindow(w, new Date(START.getTime() - 1))).toBe(false);
		expect(isInAutoVoteWindow(w, START)).toBe(true);
	});

	// protects=a ballot cast at exactly scheduled_at + length + 60 min is refused;
	// fails_when=the end is inclusive (<=) so the boundary vote lands;
	// no_claim=none beyond protects
	it("is exclusive at its end", () => {
		const w = autoVoteWindow(START, 90);
		const end = START.getTime() + 90 * 60_000 + VOTE_GRACE_AFTER_MS;
		expect(w.closesAt.getTime()).toBe(end);
		expect(isInAutoVoteWindow(w, new Date(end - 1000))).toBe(true);
		expect(isInAutoVoteWindow(w, new Date(end))).toBe(false);
	});

	// protects=the meeting's own length_minutes sets the close time;
	// fails_when=a hard-coded 90 minutes ignores a 60- or 120-minute meeting;
	// no_claim=none beyond protects
	it("honours the meeting's length", () => {
		expect(autoVoteWindow(START, 60).closesAt.getTime()).toBe(
			START.getTime() + 120 * 60_000,
		);
		expect(autoVoteWindow(START, 120).closesAt.getTime()).toBe(
			START.getTime() + 180 * 60_000,
		);
	});

	// protects=the window depends on no club timezone input;
	// fails_when=a timezone parameter is added to the signature;
	// no_claim=that callers never pass a club-local Date (they pass scheduled_at)
	it("takes only a start and a length", () => {
		expect(autoVoteWindow.length).toBe(2);
		expect(isInAutoVoteWindow.length).toBe(2);
	});
});
