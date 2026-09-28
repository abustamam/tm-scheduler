import { describe, expect, it } from "vitest";
import { feedbackWindow } from "./feedback-window";

const START = new Date("2026-10-03T16:00:00.000Z");
const at = (ms: number) => new Date(START.getTime() + ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("feedbackWindow", () => {
	it("a 90-minute meeting: opens at the start, ends 90 min later, closes 3 days after that", () => {
		const w = feedbackWindow(
			{ scheduledAt: START, lengthMinutes: 90, status: "scheduled" },
			START,
		);
		expect(w.opensAt.toISOString()).toBe("2026-10-03T16:00:00.000Z");
		expect(w.endsAt.toISOString()).toBe("2026-10-03T17:30:00.000Z");
		expect(w.closesAt.toISOString()).toBe("2026-10-06T17:30:00.000Z");
	});

	it("a 60-minute meeting ends and closes an hour after its start", () => {
		const m = { scheduledAt: START, lengthMinutes: 60, status: "scheduled" };
		const w = feedbackWindow(m, START);
		expect(w.endsAt.toISOString()).toBe("2026-10-03T17:00:00.000Z");
		expect(w.closesAt.toISOString()).toBe("2026-10-06T17:00:00.000Z");
		// The 90-minute meeting's close is still open here; the 60-minute one's is not.
		expect(feedbackWindow(m, at(60 * MIN + 3 * DAY)).canWrite).toBe(false);
		expect(
			feedbackWindow({ ...m, lengthMinutes: 90 }, at(60 * MIN + 3 * DAY))
				.canWrite,
		).toBe(true);
	});

	it("canWrite: false a millisecond before the start, true AT the start", () => {
		const m = { scheduledAt: START, lengthMinutes: 90, status: "scheduled" };
		expect(feedbackWindow(m, at(-1)).canWrite).toBe(false);
		expect(feedbackWindow(m, START).canWrite).toBe(true);
	});

	it("canWrite: true a millisecond before the close, false AT the close", () => {
		const m = { scheduledAt: START, lengthMinutes: 90, status: "completed" };
		const close = 90 * MIN + 3 * DAY;
		expect(feedbackWindow(m, at(close - 1)).canWrite).toBe(true);
		expect(feedbackWindow(m, at(close)).canWrite).toBe(false);
	});

	it("recipientsCanRead: false during the meeting, true from the scheduled end", () => {
		const m = { scheduledAt: START, lengthMinutes: 90, status: "scheduled" };
		expect(feedbackWindow(m, at(90 * MIN - 1)).recipientsCanRead).toBe(false);
		expect(feedbackWindow(m, at(90 * MIN)).recipientsCanRead).toBe(true);
		// Reading outlives writing.
		expect(feedbackWindow(m, at(30 * DAY)).recipientsCanRead).toBe(true);
	});

	it("a cancelled meeting never accepts a note, even mid-window", () => {
		const w = feedbackWindow(
			{ scheduledAt: START, lengthMinutes: 90, status: "cancelled" },
			at(30 * MIN),
		);
		expect(w.canWrite).toBe(false);
	});

	it("accepts an ISO string for scheduledAt, as a server fn hands it over", () => {
		const w = feedbackWindow(
			{
				scheduledAt: START.toISOString(),
				lengthMinutes: 90,
				status: "scheduled",
			},
			at(MIN),
		);
		expect(w.canWrite).toBe(true);
	});
});
