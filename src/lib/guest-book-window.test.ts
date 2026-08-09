import { describe, expect, it } from "vitest";
import {
	GUEST_BOOK_GRACE_AFTER_MS,
	GUEST_BOOK_GRACE_BEFORE_MS,
	isAtMeetingNow,
} from "./guest-book-window";

const MIN = 60 * 1000;
/** A meeting at a fixed instant, so no test depends on the wall clock. */
const START = new Date("2026-08-13T19:00:00-05:00");
const LEN = 90;
const at = (offsetMin: number) => new Date(START.getTime() + offsetMin * MIN);

describe("isAtMeetingNow", () => {
	it("counts a signature during the meeting", () => {
		expect(isAtMeetingNow(START, LEN, at(0))).toBe(true);
		expect(isAtMeetingNow(START, LEN, at(45))).toBe(true);
		expect(isAtMeetingNow(START, LEN, at(LEN))).toBe(true);
	});

	it("counts the officer setting up before the start", () => {
		// The #374 case: VPM opens the guest book at 18:45 for a 19:00 meeting.
		expect(isAtMeetingNow(START, LEN, at(-15))).toBe(true);
		expect(isAtMeetingNow(START, LEN, at(-89))).toBe(true);
	});

	it("counts guests mingling just after the close", () => {
		expect(isAtMeetingNow(START, LEN, at(LEN + 30))).toBe(true);
	});

	/**
	 * The FALSE POSITIVE the calendar-day version allowed. A guest following the
	 * public "Planning a visit?" link at 21:35, after a 19:00–20:30 meeting, was
	 * stamped `present` because the DATE still matched — putting someone who was
	 * never in the room into that meeting's official minutes.
	 */
	it("does NOT count a signature well after the meeting ended", () => {
		expect(isAtMeetingNow(START, LEN, at(LEN + 61))).toBe(false);
		expect(isAtMeetingNow(START, LEN, at(LEN + 240))).toBe(false);
	});

	it("does NOT count a signature days early", () => {
		expect(isAtMeetingNow(START, LEN, at(-7 * 24 * 60))).toBe(false);
		expect(isAtMeetingNow(START, LEN, at(-91))).toBe(false);
	});

	/**
	 * The FALSE NEGATIVE the calendar-day version caused, and the reason this is
	 * an absolute-time window.
	 *
	 * `clubs.timezone` defaults to `America/Chicago` and nothing in the product
	 * ever writes it, so for a club outside US Central a meeting and a signature
	 * taken minutes apart can land on DIFFERENT Chicago dates — and the real
	 * visit vanished. Expressed in absolute time, no timezone is consulted at
	 * all, so the calendar day either instant falls on stops mattering.
	 */
	it("counts a mid-meeting visit that crosses midnight in the STORED timezone", () => {
		// A Pacific club, but `clubs.timezone` says America/Chicago (the schema
		// default, which nothing in the product overwrites). The meeting starts
		// 21:30 PDT = 23:30 CDT, and the guest signs 45 minutes in, at 22:15 PDT
		// = 00:15 CDT — the NEXT Chicago date. The old date-key compare dropped
		// this guest while they were still in the room. Absolute time does not
		// care which calendar day either instant lands on.
		const start = new Date("2026-08-13T21:30:00-07:00");
		const signsAt = new Date("2026-08-13T22:15:00-07:00");
		expect(isAtMeetingNow(start, 90, signsAt)).toBe(true);
	});

	it("handles a meeting that straddles local midnight", () => {
		const lateStart = new Date("2026-08-13T23:30:00-05:00");
		const signsAt = new Date("2026-08-14T00:10:00-05:00"); // next calendar day
		expect(isAtMeetingNow(lateStart, 90, signsAt)).toBe(true);
	});

	it("scales its window with the meeting's own length", () => {
		// A 30-minute meeting closes earlier than a 120-minute one.
		const short = at(30 + 61);
		expect(isAtMeetingNow(START, 30, short)).toBe(false);
		expect(isAtMeetingNow(START, 120, short)).toBe(true);
	});

	/**
	 * ABSOLUTE ceilings on the constants, not assertions stated relative to them
	 * — a relative assertion passes for every value including one that
	 * reintroduces the bug (CLAUDE.md coverage trap 5). The upper bounds are what
	 * keep the window from swallowing an adjacent day's meeting; the lower bounds
	 * are what keep a real early/late arrival counted.
	 */
	it("keeps the grace windows within sane absolute bounds", () => {
		expect(GUEST_BOOK_GRACE_BEFORE_MS).toBeGreaterThanOrEqual(30 * MIN);
		expect(GUEST_BOOK_GRACE_BEFORE_MS).toBeLessThanOrEqual(3 * 60 * MIN);
		expect(GUEST_BOOK_GRACE_AFTER_MS).toBeGreaterThanOrEqual(15 * MIN);
		expect(GUEST_BOOK_GRACE_AFTER_MS).toBeLessThanOrEqual(3 * 60 * MIN);
		// Combined, the window must not span half a day, or two meetings on one
		// day become indistinguishable.
		const widest = GUEST_BOOK_GRACE_BEFORE_MS + GUEST_BOOK_GRACE_AFTER_MS;
		expect(widest).toBeLessThan(6 * 60 * MIN);
	});
});
