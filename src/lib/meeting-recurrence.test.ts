import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "./datetime";
import {
	generateOccurrences,
	MAX_BATCH,
	type RecurrenceInput,
} from "./meeting-recurrence";

const dates = (input: RecurrenceInput) =>
	generateOccurrences(input).occurrences.map((o) => o.date);

const daysBetween = (a: string, b: string) =>
	(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

describe("generateOccurrences — interval mode", () => {
	it("weekly by count starts on the chosen weekday and steps 7 days", () => {
		const res = generateOccurrences({
			mode: "interval",
			weekday: 2, // Tuesday
			intervalWeeks: 1,
			startDate: "2026-07-07", // a Tuesday
			timeOfDay: "19:00",
			bound: { kind: "count", count: 4 },
		});
		expect(res.occurrences.map((o) => o.date)).toEqual([
			"2026-07-07",
			"2026-07-14",
			"2026-07-21",
			"2026-07-28",
		]);
		expect(res.clamped).toBe(false);
		// time-of-day + weekday carried on every occurrence
		expect(res.occurrences.every((o) => o.wallTime.endsWith("T19:00"))).toBe(
			true,
		);
		expect(res.occurrences.every((o) => o.weekday === 2)).toBe(true);
	});

	it("biweekly steps 14 days", () => {
		expect(
			dates({
				mode: "interval",
				weekday: 2,
				intervalWeeks: 2,
				startDate: "2026-07-07",
				timeOfDay: "19:00",
				bound: { kind: "count", count: 3 },
			}),
		).toEqual(["2026-07-07", "2026-07-21", "2026-08-04"]);
	});

	it("snaps a start that is not on the weekday forward to the first match", () => {
		// 2026-07-15 is a Wednesday; first Thursday on/after is 2026-07-16.
		expect(
			dates({
				mode: "interval",
				weekday: 4, // Thursday
				intervalWeeks: 1,
				startDate: "2026-07-15",
				timeOfDay: "19:00",
				bound: { kind: "count", count: 2 },
			}),
		).toEqual(["2026-07-16", "2026-07-23"]);
	});

	it("by until-date is inclusive of the end date", () => {
		const res = generateOccurrences({
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			startDate: "2026-07-07",
			timeOfDay: "19:00",
			bound: { kind: "until", until: "2026-07-28" },
		});
		expect(res.occurrences.map((o) => o.date)).toEqual([
			"2026-07-07",
			"2026-07-14",
			"2026-07-21",
			"2026-07-28",
		]);
		expect(res.clamped).toBe(false);
	});
});

describe("generateOccurrences — monthly ordinals", () => {
	it("2nd & 4th Thursday mid-month spans the month boundary with a ~3-week gap", () => {
		// Start 2026-07-15: skips the 2nd Thursday (Jul 9, before start), so the
		// first date is the 4th Thursday Jul 23, then Aug 13 (2nd), Aug 27 (4th)…
		const res = generateOccurrences({
			mode: "monthly",
			weekday: 4, // Thursday
			ordinals: [2, 4],
			startDate: "2026-07-15",
			timeOfDay: "19:00",
			bound: { kind: "count", count: 4 },
		});
		expect(res.occurrences.map((o) => o.date)).toEqual([
			"2026-07-23",
			"2026-08-13",
			"2026-08-27",
			"2026-09-10",
		]);
		// The month-boundary gap (4th Thu Jul → 2nd Thu Aug) is 21 days, NOT 14.
		expect(daysBetween("2026-07-23", "2026-08-13")).toBe(21);
	});

	it("omits a non-existent ordinal (never shifts it)", () => {
		// 5th Thursday: exists in Jul (Jul 30) and Oct (Oct 29); Aug & Sep have
		// only four Thursdays, so those months emit nothing — not a shifted date.
		expect(
			dates({
				mode: "monthly",
				weekday: 4,
				ordinals: [5],
				startDate: "2026-07-01",
				timeOfDay: "19:00",
				bound: { kind: "until", until: "2026-10-31" },
			}),
		).toEqual(["2026-07-30", "2026-10-29"]);
	});

	it("dedupes when the 4th weekday is also the last of the month", () => {
		// August 2026 has exactly four Thursdays, so 4th === last (Aug 27).
		expect(
			dates({
				mode: "monthly",
				weekday: 4,
				ordinals: [4, "last"],
				startDate: "2026-08-01",
				timeOfDay: "19:00",
				bound: { kind: "until", until: "2026-08-31" },
			}),
		).toEqual(["2026-08-27"]);
	});
});

describe("generateOccurrences — 52-cap", () => {
	it("clamps a count over 52 to 52 and warns", () => {
		const res = generateOccurrences({
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			startDate: "2026-07-07",
			timeOfDay: "19:00",
			bound: { kind: "count", count: 100 },
		});
		expect(res.occurrences).toHaveLength(MAX_BATCH);
		expect(res.clamped).toBe(true);
	});

	it("clamps a too-wide until-range to 52 and warns", () => {
		const res = generateOccurrences({
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			startDate: "2026-07-07",
			timeOfDay: "19:00",
			bound: { kind: "until", until: "2030-01-01" },
		});
		expect(res.occurrences).toHaveLength(MAX_BATCH);
		expect(res.clamped).toBe(true);
	});

	it("does not warn when a count exactly hits the cap", () => {
		const res = generateOccurrences({
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			startDate: "2026-07-07",
			timeOfDay: "19:00",
			bound: { kind: "count", count: MAX_BATCH },
		});
		expect(res.occurrences).toHaveLength(MAX_BATCH);
		expect(res.clamped).toBe(false);
	});
});

describe("generateOccurrences — DST-spanning batch", () => {
	it("keeps the same wall-clock time across a spring-forward, DST-correct in UTC", () => {
		// Weekly Thursdays across 2026-03-08 (US spring-forward).
		const res = generateOccurrences({
			mode: "interval",
			weekday: 4,
			intervalWeeks: 1,
			startDate: "2026-02-26",
			timeOfDay: "19:00",
			bound: { kind: "count", count: 4 },
		});
		expect(res.occurrences.map((o) => o.date)).toEqual([
			"2026-02-26",
			"2026-03-05",
			"2026-03-12",
			"2026-03-19",
		]);
		// Every occurrence keeps the 19:00 wall time…
		expect(res.occurrences.every((o) => o.wallTime.endsWith("T19:00"))).toBe(
			true,
		);
		// …but the UTC instants differ by the DST offset (CST UTC-6 → CDT UTC-5).
		const before = zonedWallTimeToUtc(
			res.occurrences[0].wallTime,
			"America/Chicago",
		);
		const after = zonedWallTimeToUtc(
			res.occurrences[3].wallTime,
			"America/Chicago",
		);
		expect(before.toISOString()).toBe("2026-02-27T01:00:00.000Z"); // UTC-6
		expect(after.toISOString()).toBe("2026-03-20T00:00:00.000Z"); // UTC-5
	});
});
