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

	it("formats in the club timezone (not the host timezone)", () => {
		const start = new Date("2026-07-07T23:45:00Z");
		// Same instant is 19:45 in New York (EDT, UTC-4).
		const [ny] = buildTimeline([row(1)], start, "America/New_York");
		expect(ny.time).toBe("7:45");
	});
});
