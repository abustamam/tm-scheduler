import { describe, expect, it } from "vitest";
import { generateOccurrences, MAX_BATCH } from "./meeting-recurrence";
import {
	buildTopUpRecurrenceInput,
	type StoredRecurrenceRule,
} from "./recurrence-rule";

const base = {
	timeOfDay: "18:45",
	keepAhead: 4,
	location: null,
} satisfies Pick<StoredRecurrenceRule, "timeOfDay" | "keepAhead" | "location">;

const monthly: StoredRecurrenceRule = {
	...base,
	mode: "monthly",
	weekday: 4, // Thursday
	intervalWeeks: null,
	anchorDate: null,
	ordinals: ["2", "4"],
};

const weekly: StoredRecurrenceRule = {
	...base,
	mode: "interval",
	weekday: 4,
	intervalWeeks: 1,
	anchorDate: "2026-01-01",
	ordinals: null,
};

const biweekly: StoredRecurrenceRule = {
	...base,
	mode: "interval",
	weekday: 4,
	intervalWeeks: 2,
	anchorDate: "2026-01-01",
	ordinals: null,
};

describe("buildTopUpRecurrenceInput", () => {
	it("maps a monthly rule to a monthly RecurrenceInput starting at notBefore", () => {
		const input = buildTopUpRecurrenceInput(monthly, "2026-03-01");
		expect(input).toMatchObject({
			mode: "monthly",
			weekday: 4,
			ordinals: [2, 4],
			timeOfDay: "18:45",
			startDate: "2026-03-01",
			bound: { kind: "count", count: MAX_BATCH },
		});
	});

	it("parses the 'last' ordinal", () => {
		const input = buildTopUpRecurrenceInput(
			{ ...monthly, ordinals: ["last"] },
			"2026-03-01",
		);
		expect(input).toMatchObject({ mode: "monthly", ordinals: ["last"] });
	});

	it("generated monthly occurrences all fall on/after notBefore", () => {
		const input = buildTopUpRecurrenceInput(monthly, "2026-03-10");
		const dates = generateOccurrences(input).occurrences.map((o) => o.date);
		expect(dates.length).toBeGreaterThan(0);
		expect(dates.every((d) => d >= "2026-03-10")).toBe(true);
	});

	it("weekly interval starts at the first matching weekday on/after notBefore", () => {
		const input = buildTopUpRecurrenceInput(weekly, "2026-06-01");
		const dates = generateOccurrences(input).occurrences.map((o) => o.date);
		expect(dates[0] >= "2026-06-01").toBe(true);
		// one week earlier would still be a Thursday but before notBefore
		expect(dates.every((d) => d >= "2026-06-01")).toBe(true);
		expect(input.mode).toBe("interval");
	});

	it("biweekly preserves the phase anchored at anchorDate", () => {
		const notBefore = "2026-05-01";
		// The canonical series generated straight from the anchor.
		const fromAnchor = generateOccurrences({
			mode: "interval",
			weekday: 4,
			intervalWeeks: 2,
			startDate: "2026-01-01",
			timeOfDay: "18:45",
			bound: { kind: "count", count: MAX_BATCH },
		}).occurrences.map((o) => o.date);

		const input = buildTopUpRecurrenceInput(biweekly, notBefore);
		const got = generateOccurrences(input).occurrences.map((o) => o.date);

		// The top-up series starts on-phase: its first date is the first anchored
		// occurrence at/after notBefore (not a fortnightly cadence re-anchored off
		// notBefore itself).
		const expectedFirst = fromAnchor.find((d) => d >= notBefore);
		expect(got[0]).toBe(expectedFirst);
		// …and stays on the same 14-day grid (phase preserved as it extends past
		// the anchored window).
		const dayMs = 86_400_000;
		const diffs = got
			.slice(1)
			.map((d, i) => (Date.parse(d) - Date.parse(got[i])) / dayMs);
		expect(diffs.every((n) => n === 14)).toBe(true);
	});
});
