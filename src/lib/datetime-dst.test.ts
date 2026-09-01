/**
 * `zonedWallTimeToUtc` round-trips across DST transitions, in every zone the
 * club timezone picker offers (#547).
 *
 * ## Why this sweep exists rather than a handful of named cases
 *
 * The defect it guards was invisible for the life of the app because only ONE
 * zone was ever reachable: `clubs.timezone` had no writer before #547, and
 * `America/Chicago` transitions at 02:00 local, which no club meets across.
 * Making the other 418 zones selectable exposed a latent bug in 14 of them at
 * ordinary evening meeting hours. A test naming those 14 would pin the symptom;
 * sweeping the LIST pins the property, and enrolls whatever the next ICU update
 * adds to `CLUB_TIMEZONES` without anyone remembering to.
 *
 * That matters more than usual here because the input axis is not the code — it
 * is the IANA database, which changes several times a year and is shipped by the
 * runtime rather than this repo. A zone that starts observing DST next year gets
 * checked by this test on the next `bun run test`, and by nothing else.
 *
 * ## Reading a failure
 *
 * A failure prints `zone: <typed> -> <redisplayed>`. That is the whole bug: an
 * admin types 19:00, the app stores an instant, and the app shows them 20:00.
 * Nothing throws.
 */
import { describe, expect, it } from "vitest";
import { CLUB_TIMEZONES } from "./club-timezone";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "./datetime";

/**
 * Wall times that name no instant, because the zone skipped them at a
 * spring-forward. `22:00` does not exist on Easter Island's changeover day —
 * clocks jump 22:00 to 23:00 — so no return value can round-trip, and this is a
 * property of the calendar rather than of the code under test.
 *
 * Listed exactly, never as a pattern: a broad skip would hide a real regression
 * in a zone that merely resembles this one. If a future IANA release moves this
 * transition, the extra entry fails `gapsAreStillGaps` below rather than being
 * silently tolerated.
 */
const KNOWN_GAPS = new Set(["Pacific/Easter\t2026-09-05T22:00"]);

/** Hours a Toastmasters club plausibly meets at — the band that matters. */
const MEETING_HOURS = ["18", "19", "20", "21", "22"];

function sweep(): { key: string; zone: string; typed: string; got: string }[] {
	const failures: { key: string; zone: string; typed: string; got: string }[] =
		[];
	for (const zone of CLUB_TIMEZONES) {
		for (let month = 1; month <= 12; month++) {
			for (let day = 1; day <= 28; day++) {
				for (const hh of MEETING_HOURS) {
					const typed = `2026-${String(month).padStart(2, "0")}-${String(
						day,
					).padStart(2, "0")}T${hh}:00`;
					const got = utcToZonedWallTime(zonedWallTimeToUtc(typed, zone), zone);
					if (got !== typed) {
						failures.push({ key: `${zone}\t${typed}`, zone, typed, got });
					}
				}
			}
		}
	}
	return failures;
}

describe("zonedWallTimeToUtc survives DST transitions (#547)", () => {
	const failures = sweep();

	it("sweeps a meaningful number of zones and hours", () => {
		// Vacuity guard: every assertion below is over `failures`, so an empty
		// CLUB_TIMEZONES (or a sweep that silently stopped) would pass all of them
		// while checking nothing.
		expect(CLUB_TIMEZONES.length).toBeGreaterThan(400);
		expect(MEETING_HOURS.length).toBeGreaterThan(0);
	});

	it("round-trips every offered zone at every evening hour of 2026", () => {
		const real = failures.filter((f) => !KNOWN_GAPS.has(f.key));
		// Absolute, not relative: the assertion is "no zone stores a time other
		// than the one typed", which cannot be satisfied by loosening a constant.
		expect(
			real.map((f) => `${f.zone}: ${f.typed} -> ${f.got}`),
			"a zone stored a different time than was typed",
		).toEqual([]);
	});

	it("gapsAreStillGaps — every waived entry is genuinely a skipped wall time", () => {
		// The waiver has to keep EARNING it. A `KNOWN_GAPS` entry that starts
		// round-tripping means the calendar moved and the waiver is now hiding a
		// live case, so fail rather than carry a stale exemption.
		for (const key of KNOWN_GAPS) {
			const [zone, typed] = key.split("\t") as [string, string];
			expect(
				failures.some((f) => f.key === key),
				`${zone} ${typed} now round-trips — drop it from KNOWN_GAPS`,
			).toBe(true);
			// And PROVE it is a gap rather than a bug we waived: the hours either
			// side must round-trip cleanly. If 21:00 and 23:00 both survive and
			// 22:00 does not, 22:00 is a wall time the calendar skipped — no return
			// value could have satisfied it. A real defect would not be bounded
			// like that.
			//
			// Direction is deliberately NOT asserted. This one resolves BACKWARD
			// (22:00 comes back as 21:00), which the first draft of this test got
			// wrong by assuming a skipped hour must shift forward. Which side a gap
			// falls on is an artifact of the two-pass correction, not a promise.
			const hour = Number(typed.slice(11, 13));
			const at = (h: number) =>
				`${typed.slice(0, 11)}${String(h).padStart(2, "0")}:00`;
			expect(got(zone, at(hour - 1))).toBe(at(hour - 1));
			expect(got(zone, at(hour + 1))).toBe(at(hour + 1));
		}
	});

	it("still round-trips the column default, which was never broken", () => {
		// The regression direction: America/Chicago worked before the fix and must
		// keep working. It is the zone every existing club is on.
		for (const typed of [
			"2026-03-08T19:00",
			"2026-11-01T19:00",
			"2026-06-15T19:00",
		]) {
			expect(got("America/Chicago", typed)).toBe(typed);
		}
	});

	it("round-trips a half-hour and a 45-minute offset zone", () => {
		// Offsets that are not whole hours are their own failure shape — the
		// two-pass correction must not assume hour granularity.
		expect(got("Asia/Calcutta", "2026-06-15T19:00")).toBe("2026-06-15T19:00");
		expect(got("Australia/Eucla", "2026-06-15T19:00")).toBe("2026-06-15T19:00");
	});
});

function got(zone: string, typed: string): string {
	return utcToZonedWallTime(zonedWallTimeToUtc(typed, zone), zone);
}
