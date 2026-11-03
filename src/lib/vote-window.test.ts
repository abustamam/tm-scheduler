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
	// fails_when=the end is inclusive (<=) so the boundary vote lands, or the
	//   grace is mis-added;
	// no_claim=the grace constant itself (pinned below)
	it("is exclusive at its end", () => {
		// 19:00Z start + 90 min meeting + 60 min grace = 21:30Z, stated absolutely.
		const w = autoVoteWindow(START, 90);
		const end = new Date("2026-10-31T21:30:00.000Z");
		expect(w.closesAt.getTime()).toBe(end.getTime());
		expect(isInAutoVoteWindow(w, new Date(end.getTime() - 1))).toBe(true);
		expect(isInAutoVoteWindow(w, end)).toBe(false);
	});

	// protects=ballots stay open 60 minutes past the planned end, even if the
	//   guest book's grace (which it was borrowed from) is changed;
	// fails_when=VOTE_GRACE_AFTER_MS is no longer 60 minutes;
	// no_claim=that the guest book keeps its own 60 minutes
	it("pins the grace at 60 minutes", () => {
		expect(VOTE_GRACE_AFTER_MS).toBe(60 * 60 * 1000);
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
});
