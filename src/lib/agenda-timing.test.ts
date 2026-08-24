// src/lib/agenda-timing.test.ts
import { describe, expect, it } from "vitest";
import type { AgendaRow } from "./agenda-runsheet";
import { buildTimeline, timelineEnd } from "./agenda-timing";

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

describe("timelineEnd", () => {
	/** 6:45 PM America/Chicago on 2026-09-10 — MCF's club contest. */
	const START = new Date("2026-09-10T23:45:00.000Z");

	it("returns the clock time after every row's duration", () => {
		// The seeded contest's three segments at four contestants: 25 + 39 + 28.
		expect(
			timelineEnd(
				[{ minutes: 25 }, { minutes: 39 }, { minutes: 28 }],
				START,
				"America/Chicago",
			),
		).toBe("8:17");
	});

	it("returns the start itself for an empty agenda", () => {
		expect(timelineEnd([], START, "America/Chicago")).toBe("6:45");
	});

	it("agrees with buildTimeline's last row plus its own duration", () => {
		// Stated as an agreement so the two cannot drift: the end of an agenda is
		// the last row's start plus that row's minutes, and both derive from the
		// same cursor.
		const rows = [row(25), row(39), row(28)];
		const timed = buildTimeline(rows, START, "America/Chicago");
		expect(timed.at(-1)?.time).toBe("7:49");
		expect(timelineEnd(rows, START, "America/Chicago")).toBe("8:17");
	});

	it("formats in the club timezone, like buildTimeline", () => {
		expect(timelineEnd([{ minutes: 60 }], START, "America/New_York")).toBe(
			"8:45",
		);
	});

	it("crosses midnight without wrapping to a negative clock", () => {
		// 11:30 PM Chicago plus 90 minutes. `formatClock` takes hours mod 24, so
		// this asserts the wrap lands on 1:00 rather than 25:00 or a negative.
		const late = new Date("2026-09-11T04:30:00.000Z");
		expect(timelineEnd([{ minutes: 90 }], late, "America/Chicago")).toBe(
			"1:00",
		);
	});
});
