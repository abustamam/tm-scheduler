import { describe, expect, it } from "vitest";
import {
	dollarsToCents,
	formatCents,
	nextRenewalDate,
	selectActivePeriodId,
	TI_RENEWAL_PRESETS,
} from "./dues";

describe("selectActivePeriodId", () => {
	const apr = { id: "apr", dueDate: new Date("2026-04-01") };
	const oct = { id: "oct", dueDate: new Date("2026-10-01") };

	it("returns null when there are no periods", () => {
		expect(selectActivePeriodId([])).toBeNull();
	});

	it("picks the latest period already due (window contains today)", () => {
		// A day inside Apr's window (Apr 1 .. Oct 1).
		expect(selectActivePeriodId([apr, oct], new Date("2026-06-15"))).toBe(
			"apr",
		);
		// A day inside Oct's window (Oct 1 onward).
		expect(selectActivePeriodId([apr, oct], new Date("2026-11-15"))).toBe(
			"oct",
		);
	});

	it("falls back to the nearest upcoming when all periods are future", () => {
		expect(selectActivePeriodId([oct, apr], new Date("2026-01-01"))).toBe(
			"apr",
		);
	});

	it("does not require the input to be pre-sorted", () => {
		expect(selectActivePeriodId([oct, apr], new Date("2026-06-15"))).toBe(
			"apr",
		);
	});
});

describe("dollarsToCents", () => {
	it("parses blank as null", () => {
		expect(dollarsToCents("")).toBeNull();
		expect(dollarsToCents("   ")).toBeNull();
	});

	it("parses whole and fractional dollars to integer cents", () => {
		expect(dollarsToCents("45")).toBe(4500);
		expect(dollarsToCents("45.50")).toBe(4550);
		expect(dollarsToCents("$1,234.05")).toBe(123405);
	});

	it("throws on a malformed amount", () => {
		expect(() => dollarsToCents("abc")).toThrow();
		expect(() => dollarsToCents("1.234")).toThrow();
	});
});

describe("formatCents", () => {
	it("renders a dash for null", () => {
		expect(formatCents(null)).toBe("—");
	});
	it("renders USD currency", () => {
		expect(formatCents(4500)).toBe("$45.00");
	});
});

describe("nextRenewalDate", () => {
	it("returns this year's date when it's still upcoming", () => {
		const apr = TI_RENEWAL_PRESETS.find((p) => p.key === "apr");
		if (!apr) throw new Error("missing preset");
		const d = nextRenewalDate(apr, new Date(2026, 0, 15)); // Jan 15
		expect(d.getFullYear()).toBe(2026);
		expect(d.getMonth()).toBe(3); // April (0-based)
		expect(d.getDate()).toBe(1);
	});

	it("rolls to next year once the date has passed", () => {
		const apr = TI_RENEWAL_PRESETS.find((p) => p.key === "apr");
		if (!apr) throw new Error("missing preset");
		const d = nextRenewalDate(apr, new Date(2026, 5, 1)); // Jun 1
		expect(d.getFullYear()).toBe(2027);
	});
});
