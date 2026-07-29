// src/lib/agenda-timing.test.ts
import { describe, expect, it } from "vitest";
import type { AgendaRow } from "./agenda-runsheet";
import { buildTimeline } from "./agenda-timing";

function row(minutes: number): AgendaRow {
	return { who: "x", detail: "", minutes, marks: null };
}

describe("buildTimeline", () => {
	it("assigns each row a running clock time = start + sum of PRIOR durations", () => {
		// 2026-07-07 18:45 America/Chicago (CDT, UTC-5) == 23:45 UTC.
		const start = new Date("2026-07-07T23:45:00Z");
		const rows = [row(1), row(1), row(3)];
		const timed = buildTimeline(rows, start, "America/Chicago");
		expect(timed.map((r) => r.time)).toEqual(["6:45", "6:46", "6:47"]);
	});

	it("carries the row content through unchanged", () => {
		const start = new Date("2026-07-07T23:45:00Z");
		const [first] = buildTimeline(
			[
				{
					who: "Speaker 1 · A",
					detail: '"T"',
					minutes: 7,
					marks: { green: 5, yellow: 6, red: 7 },
				},
			],
			start,
			"America/Chicago",
		);
		expect(first.who).toBe("Speaker 1 · A");
		expect(first.marks).toEqual({ green: 5, yellow: 6, red: 7 });
	});

	// The invariant the hand-off band is built on (#363): a 0-minute row does not
	// advance the clock, so it and the row it introduces start at the same time.
	// Task 6's compact band prints the stamp once rather than twice.
	it("gives a 0-minute row and the row after it the same stamp", () => {
		const start = new Date("2026-07-07T23:45:00Z");
		const timed = buildTimeline(
			[row(3), row(0), row(7)],
			start,
			"America/Chicago",
		);
		expect(timed.map((r) => r.time)).toEqual(["6:45", "6:48", "6:48"]);
	});

	// The seam between the two halves of #363: `expandRunSheet` sets `handoff`
	// and the four print layouts read it off a TimelineRow, but nothing pinned
	// the step in between. `TimelineRow = AgendaRow & { time }` does not help —
	// both markers are OPTIONAL, so a rewrite that built the row field-by-field
	// instead of spreading would drop them and still type-check, and every
	// hand-off would silently render as a full segment block again.
	it("carries the hand-off and flex markers onto the timed row", () => {
		const timed = buildTimeline(
			[
				{ ...row(0), handoff: true },
				{ ...row(10), flex: true },
			],
			new Date("2026-07-07T23:45:00Z"),
			"America/Chicago",
		);
		expect(timed[0].handoff).toBe(true);
		expect(timed[1].flex).toBe(true);
		// …and an unmarked row stays unmarked, so the assertions above are not
		// passing off a blanket default as the flag.
		expect(
			buildTimeline([row(1)], new Date(), "UTC")[0].handoff,
		).toBeUndefined();
	});

	it("formats in the club timezone (not the host timezone)", () => {
		const start = new Date("2026-07-07T23:45:00Z");
		// Same instant is 19:45 in New York (EDT, UTC-4).
		const [ny] = buildTimeline([row(1)], start, "America/New_York");
		expect(ny.time).toBe("7:45");
	});
});
