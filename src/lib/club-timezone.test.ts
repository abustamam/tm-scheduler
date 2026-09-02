/**
 * The club timezone allowlist and validator (#547).
 *
 * These assertions are deliberately built from properties rather than from a
 * roster of zone names. `Intl.supportedValuesOf("timeZone")` is the ICU build's
 * list, and this repo runs on at least two of them (a Mac locally, Ubuntu in
 * CI) that genuinely disagree about which spelling of an alias pair is
 * canonical — this Node lists `Asia/Calcutta`, a newer ICU lists
 * `Asia/Kolkata`. A test naming either one asserts which binary ran it. So the
 * only zone named here is the column default, which every ICU carries.
 */
import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import {
	CLUB_TIMEZONES,
	DEFAULT_CLUB_TIMEZONE,
	isSupportedClubTimezone,
} from "./club-timezone";

describe("club timezone allowlist", () => {
	it("is a non-empty, sorted, duplicate-free list", () => {
		// Non-empty is the assertion that matters: an empty list would make every
		// zone invalid and the picker blank, and every membership assertion below
		// would still pass vacuously.
		expect(CLUB_TIMEZONES.length).toBeGreaterThan(100);
		expect([...CLUB_TIMEZONES]).toEqual([...CLUB_TIMEZONES].sort());
		expect(new Set(CLUB_TIMEZONES).size).toBe(CLUB_TIMEZONES.length);
	});

	it("contains the column default, so an untouched club is already valid", () => {
		expect(isSupportedClubTimezone(DEFAULT_CLUB_TIMEZONE)).toBe(true);
		expect(CLUB_TIMEZONES).toContain(DEFAULT_CLUB_TIMEZONE);
	});

	it("contains UTC, which the raw Intl list omits on these ICU builds", () => {
		expect(isSupportedClubTimezone("UTC")).toBe(true);
	});

	it("accepts every zone it offers — the picker cannot show a rejected option", () => {
		const rejected = CLUB_TIMEZONES.filter((z) => !isSupportedClubTimezone(z));
		expect(rejected).toEqual([]);
	});

	it("offers only zones the datetime helpers can actually resolve", () => {
		// The column feeds `zonedWallTimeToUtc` on every meeting write; a zone
		// `Intl` cannot resolve throws a RangeError there rather than degrading,
		// so an unresolvable option in the picker takes out meeting creation.
		const unresolvable = CLUB_TIMEZONES.filter((z) => {
			try {
				zonedWallTimeToUtc("2026-06-15T19:00", z);
				return false;
			} catch {
				return true;
			}
		});
		expect(unresolvable).toEqual([]);
	});

	it("rejects garbage, blanks and near-misses", () => {
		for (const bad of [
			"",
			"   ",
			"Not/AZone",
			"america/chicago", // real zone, wrong case — not canonical
			"Chicago",
			"GMT+5",
			"+05:30",
			"UTC ",
			"America/Chicago ",
		]) {
			expect(isSupportedClubTimezone(bad)).toBe(false);
		}
	});

	it("rejects a zone Intl would happily format with but that is not canonical", () => {
		// `Intl.DateTimeFormat` accepts these; exact-membership does not. This is
		// the gap the validator exists to close — see `isSupportedClubTimezone`.
		const tolerated = ["utc", "Etc/GMT+5"].filter((z) => {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: z }).format(new Date());
				return true;
			} catch {
				return false;
			}
		});
		expect(tolerated.length).toBeGreaterThan(0);
		for (const z of tolerated) expect(isSupportedClubTimezone(z)).toBe(false);
	});
});
