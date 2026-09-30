import { describe, expect, it } from "vitest";
import {
	compareOrientationRows,
	daysInOrientation,
	isStalledInOrientation,
	ORIENTATION_STALLED_AFTER_DAYS,
	orientationDayLabel,
} from "./orientation-roster";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("orientation roster (#942)", () => {
	it("the stalled threshold is 28 days", () => {
		expect(ORIENTATION_STALLED_AFTER_DAYS).toBe(28);
	});

	it.each([
		[27, false],
		[28, false],
		[29, true],
	])("day %i stalled: %s", (days, stalled) => {
		expect(isStalledInOrientation(daysInOrientation(daysAgo(days), NOW))).toBe(
			stalled,
		);
	});

	it("counts whole elapsed days, floored", () => {
		expect(daysInOrientation(new Date(daysAgo(29).getTime() + 1), NOW)).toBe(
			28,
		);
		expect(daysInOrientation(daysAgo(0), NOW)).toBe(0);
	});

	it("never goes negative", () => {
		expect(daysInOrientation(new Date(NOW.getTime() + DAY), NOW)).toBe(0);
	});

	it("sorts earliest start first, then by name", () => {
		const rows = [
			{ name: "Cy", startedAt: daysAgo(2) },
			{ name: "Bea", startedAt: daysAgo(9) },
			{ name: "Al", startedAt: daysAgo(2) },
		];
		expect(rows.sort(compareOrientationRows).map((r) => r.name)).toEqual([
			"Bea",
			"Al",
			"Cy",
		]);
	});

	it("labels day 0 as started today", () => {
		expect(orientationDayLabel(0)).toBe("Started today");
		expect(orientationDayLabel(12)).toBe("Day 12");
	});
});
