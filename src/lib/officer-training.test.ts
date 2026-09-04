/**
 * Unit tests for the pure Club Officer Training rules (#531).
 *
 * Every number here is asserted ABSOLUTELY, against a literal, and that is the
 * point of the file rather than a style choice. The substance of #531 IS a set
 * of numbers — the four-officer bar and the four window bounds — and CLAUDE.md
 * records the trap: `expect(trained).toBeLessThanOrEqual(REQUIRED)` passes for
 * every value of REQUIRED, including one that reintroduces the bug. Nothing
 * below reads a constant from the module to build its own expectation.
 */
import { describe, expect, it } from "vitest";
import {
	countTrainedOfficers,
	daysBetween,
	daysUntilClose,
	defaultTrainingWindow,
	defaultTrainingWindows,
	focusPeriod,
	formatIsoDate,
	isLeapYear,
	isOutsideWindow,
	isPeriodMet,
	isTrainablePosition,
	isTrainingPeriod,
	suggestG9,
	TRAINABLE_OFFICER_POSITIONS,
	TRAINED_OFFICERS_REQUIRED,
	TRAINING_PERIODS,
	type TrainingRecordLike,
	tallyPeriod,
	todayIso,
	trainingPeriodLabel,
	untrainedSeats,
	windowPhase,
} from "./officer-training";

// ---------------------------------------------------------------------------
// The constants themselves
// ---------------------------------------------------------------------------

describe("the bar", () => {
	it("is exactly four officers per period", () => {
		// TI: "A minimum of four club officer roles trained during each of the two
		// training periods." Literal 4 — a relative assertion here would pass for
		// a bar of 1 (goal 9 met by one officer) or 40 (never met).
		expect(TRAINED_OFFICERS_REQUIRED).toBe(4);
	});

	it("has exactly two training periods, 1 then 2", () => {
		expect([...TRAINING_PERIODS]).toEqual([1, 2]);
	});

	it("counts the seven ELECTED offices and excludes Immediate Past President", () => {
		// TI names seven. `officerPositionEnum` carries eight; the eighth is a
		// courtesy title with no training attached, and counting it would let a
		// club clear the bar with three trained officers plus an IPP row.
		expect([...TRAINABLE_OFFICER_POSITIONS]).toEqual([
			"president",
			"vp_education",
			"vp_membership",
			"vp_public_relations",
			"secretary",
			"treasurer",
			"sergeant_at_arms",
		]);
		expect(TRAINABLE_OFFICER_POSITIONS).toHaveLength(7);
		expect(isTrainablePosition("immediate_past_president")).toBe(false);
		expect(isTrainablePosition("sergeant_at_arms")).toBe(true);
	});

	it("guards and labels the period value", () => {
		expect(isTrainingPeriod(1)).toBe(true);
		expect(isTrainingPeriod(2)).toBe(true);
		expect(isTrainingPeriod(0)).toBe(false);
		expect(isTrainingPeriod(3)).toBe(false);
		expect(isTrainingPeriod("1")).toBe(false);
		expect(trainingPeriodLabel(1)).toBe("First period");
		expect(trainingPeriodLabel(2)).toBe("Second period");
	});
});

// ---------------------------------------------------------------------------
// TI's default windows
// ---------------------------------------------------------------------------

describe("defaultTrainingWindow", () => {
	it("puts period 1 at Jun 1 – Aug 31 of the program year", () => {
		expect(defaultTrainingWindow(2026, 1)).toEqual({
			period: 1,
			startsOn: "2026-06-01",
			endsOn: "2026-08-31",
		});
	});

	it("puts period 2 at Nov 1 of the program year – Feb 28 of the next", () => {
		// Program year 2026 = Jul 1 2026 – Jun 30 2027, so period 2 STARTS in
		// calendar 2026 and ENDS in calendar 2027. A window built entirely out of
		// `programYear + 1` would read Nov 1 2027 – Feb 28 2028: a whole year late,
		// and still inside no scoreboard the club is looking at.
		expect(defaultTrainingWindow(2026, 2)).toEqual({
			period: 2,
			startsOn: "2026-11-01",
			endsOn: "2027-02-28",
		});
	});

	it("ends period 2 on Feb 29 in a leap year", () => {
		// Program year 2027 ends in calendar 2028, which is a leap year.
		expect(defaultTrainingWindow(2027, 2).endsOn).toBe("2028-02-29");
	});

	it("applies the century rule, not just divisible-by-four", () => {
		// 2100 is NOT a leap year (divisible by 100, not by 400); 2400 is.
		expect(isLeapYear(2028)).toBe(true);
		expect(isLeapYear(2027)).toBe(false);
		expect(isLeapYear(2100)).toBe(false);
		expect(isLeapYear(2400)).toBe(true);
		expect(defaultTrainingWindow(2099, 2).endsOn).toBe("2100-02-28");
		expect(defaultTrainingWindow(2399, 2).endsOn).toBe("2400-02-29");
	});

	it("period 1 deliberately starts BEFORE the program year does", () => {
		// Jun 1 2026 belongs to program year 2025 (Jul 2025 – Jun 2026). TI trains
		// incoming officers a month before their term begins, so the window is
		// scoped to (club, program_year, period) rather than clipped to the
		// program-year window. Guarding it so a future "tidy-up" that clips period 1
		// to Jul 1 fails here rather than silently shortening every club's window
		// by a third.
		const p1 = defaultTrainingWindow(2026, 1);
		expect(p1.startsOn).toBe("2026-06-01");
		expect(p1.startsOn < "2026-07-01").toBe(true);
	});

	it("returns both windows in chronological order", () => {
		const [first, second] = defaultTrainingWindows(2026);
		expect(first?.period).toBe(1);
		expect(second?.period).toBe(2);
		expect(first && second && first.endsOn < second.startsOn).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Window phase / countdown
// ---------------------------------------------------------------------------

const P1_2026 = defaultTrainingWindow(2026, 1); // 2026-06-01 .. 2026-08-31

describe("windowPhase", () => {
	it("treats both bounds as INSIDE the window", () => {
		expect(windowPhase(P1_2026, "2026-06-01")).toBe("open");
		expect(windowPhase(P1_2026, "2026-08-31")).toBe("open");
	});

	it("reads a day either side correctly", () => {
		expect(windowPhase(P1_2026, "2026-05-31")).toBe("upcoming");
		expect(windowPhase(P1_2026, "2026-09-01")).toBe("closed");
	});
});

describe("daysUntilClose", () => {
	it("counts the last day inclusively, so 0 means 'closes today'", () => {
		expect(daysUntilClose(P1_2026, "2026-08-31")).toBe(0);
		expect(daysUntilClose(P1_2026, "2026-08-30")).toBe(1);
	});

	it("is an absolute day count from an upcoming date", () => {
		// 2026-08-01 → 2026-08-31 is 30 days.
		expect(daysUntilClose(P1_2026, "2026-08-01")).toBe(30);
	});

	it("is null once the window has shut", () => {
		expect(daysUntilClose(P1_2026, "2026-09-01")).toBeNull();
	});

	it("survives a DST boundary exactly", () => {
		// US DST spring-forward 2026 is Mar 8. A local-midnight Date subtraction
		// yields 22.958… days here and floors to 22; parsing as UTC gives 23.
		expect(daysBetween("2026-03-01", "2026-03-24")).toBe(23);
		// Autumn fall-back 2026 is Nov 1 — the mirror error, rounding up.
		expect(daysBetween("2026-10-25", "2026-11-08")).toBe(14);
	});

	it("is negative when the target is in the past", () => {
		expect(daysBetween("2026-09-01", "2026-08-31")).toBe(-1);
	});
});

describe("formatIsoDate", () => {
	it("renders the string's own parts, never a parsed Date", () => {
		// `new Date("2026-06-01").toLocaleDateString()` prints "May 31" for every
		// viewer west of Greenwich, because the string parses as UTC midnight. The
		// bound being displayed IS the deadline, so that off-by-one is the one this
		// formatter exists to avoid.
		expect(formatIsoDate("2026-06-01")).toBe("Jun 1, 2026");
		expect(formatIsoDate("2027-02-28")).toBe("Feb 28, 2027");
		expect(formatIsoDate("2026-12-31")).toBe("Dec 31, 2026");
	});

	it("passes a non-ISO string through rather than rendering NaN", () => {
		expect(formatIsoDate("not a date")).toBe("not a date");
		expect(formatIsoDate("2026-13-01")).toBe("2026-13-01");
	});
});

describe("todayIso", () => {
	it("formats the LOCAL calendar date, zero-padded", () => {
		// Local, not UTC: 23:30 local on Jan 5 is Jan 6 in UTC for anyone west of
		// Greenwich, and a club reading "closes in 3 days" means its own calendar.
		expect(todayIso(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
		expect(todayIso(new Date(2026, 8, 9, 0, 1))).toBe("2026-09-09");
	});
});

// ---------------------------------------------------------------------------
// Counting: distinct PEOPLE
// ---------------------------------------------------------------------------

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const CARA = "33333333-3333-3333-3333-333333333333";
const DAN = "44444444-4444-4444-4444-444444444444";
const ERIN = "55555555-5555-5555-5555-555555555555";

function rec(
	membershipId: string,
	position: TrainingRecordLike["position"],
	period: 1 | 2,
): TrainingRecordLike {
	return { membershipId, position, period };
}

describe("countTrainedOfficers", () => {
	it("counts a dual-office holder ONCE (distinct people, not offices)", () => {
		// The divergence case the whole rule turns on. Four RECORDS across three
		// PEOPLE: Alice is Secretary + Treasurer. Distinct-offices would say 4 and
		// clear the bar; distinct-people says 3 and does not.
		const records = [
			rec(ALICE, "secretary", 1),
			rec(ALICE, "treasurer", 1),
			rec(BOB, "president", 1),
			rec(CARA, "vp_education", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(3);
		expect(isPeriodMet(countTrainedOfficers(records, 1))).toBe(false);
	});

	it("clears the bar at four distinct people", () => {
		const records = [
			rec(ALICE, "secretary", 1),
			rec(ALICE, "treasurer", 1),
			rec(BOB, "president", 1),
			rec(CARA, "vp_education", 1),
			rec(DAN, "sergeant_at_arms", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(4);
		expect(isPeriodMet(countTrainedOfficers(records, 1))).toBe(true);
	});

	it("ignores an Immediate Past President record entirely", () => {
		// The untrainable office is dropped BEFORE the de-dup, so Erin — who holds
		// only that office — contributes 0, not 1. Counting her would clear the bar
		// on three real officers.
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "vp_education", 1),
			rec(CARA, "secretary", 1),
			rec(ERIN, "immediate_past_president", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(3);
	});

	it("does not let an IPP row rescue a person's other office", () => {
		// Mirror of the above: Alice holds IPP *and* Treasurer. The IPP row is
		// dropped, the Treasurer row still counts her once.
		const records = [
			rec(ALICE, "immediate_past_president", 1),
			rec(ALICE, "treasurer", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(1);
	});

	it("scores each period separately", () => {
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "vp_education", 1),
			rec(CARA, "secretary", 1),
			rec(DAN, "treasurer", 1),
			rec(ALICE, "president", 2),
		];
		expect(countTrainedOfficers(records, 1)).toBe(4);
		expect(countTrainedOfficers(records, 2)).toBe(1);
	});

	it("is zero for an empty record set", () => {
		expect(countTrainedOfficers([], 1)).toBe(0);
		expect(countTrainedOfficers([], 2)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The goal-9 suggestion
// ---------------------------------------------------------------------------

describe("suggestG9", () => {
	const four = (period: 1 | 2) => [
		rec(ALICE, "president", period),
		rec(BOB, "vp_education", period),
		rec(CARA, "secretary", period),
		rec(DAN, "treasurer", period),
	];

	it("suggests 1 only when BOTH periods clear four", () => {
		expect(suggestG9([...four(1), ...four(2)])).toBe(1);
	});

	it("suggests 0 when the second period is one short", () => {
		// The failure #531 exists to make visible: three trained in the second
		// window, the window shut, the point gone. The suggestion must not round up.
		const records = [...four(1), ...four(2).slice(0, 3)];
		expect(countTrainedOfficers(records, 2)).toBe(3);
		expect(suggestG9(records)).toBe(0);
	});

	it("suggests 0 when only one period is recorded at all", () => {
		expect(suggestG9(four(1))).toBe(0);
		expect(suggestG9(four(2))).toBe(0);
	});

	it("suggests 0 with no records", () => {
		expect(suggestG9([])).toBe(0);
	});

	it("suggests 0 when eight offices are covered by three people per period", () => {
		// Distinct-offices would clear both periods here (4 offices each); the
		// distinct-people rule does not. Guards the conservative reading against a
		// refactor that de-dups on office.
		const perPeriod = (period: 1 | 2) => [
			rec(ALICE, "secretary", period),
			rec(ALICE, "treasurer", period),
			rec(BOB, "president", period),
			rec(CARA, "vp_education", period),
		];
		expect(suggestG9([...perPeriod(1), ...perPeriod(2)])).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Out-of-window records
// ---------------------------------------------------------------------------

describe("isOutsideWindow", () => {
	it("flags a date before the window opens and after it shuts", () => {
		expect(isOutsideWindow("2026-05-31", P1_2026)).toBe(true);
		expect(isOutsideWindow("2026-09-01", P1_2026)).toBe(true);
	});

	it("accepts both inclusive bounds", () => {
		expect(isOutsideWindow("2026-06-01", P1_2026)).toBe(false);
		expect(isOutsideWindow("2026-08-31", P1_2026)).toBe(false);
	});

	it("does not flag an unrecorded date", () => {
		// A club often knows an officer was trained without knowing the day.
		// Treating null as an offence would push them to invent a date.
		expect(isOutsideWindow(null, P1_2026)).toBe(false);
	});

	it("does NOT change the count — the flag is advisory only", () => {
		// TI is the arbiter; the app surfaces the mismatch rather than silently
		// voiding the claim. A record dated a year off still counts.
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "vp_education", 1),
			rec(CARA, "secretary", 1),
			rec(DAN, "treasurer", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(4);
		expect(isOutsideWindow("2025-01-01", P1_2026)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Display grain
// ---------------------------------------------------------------------------

describe("untrainedSeats", () => {
	const seats = [
		{ membershipId: ALICE, name: "Alice", position: "secretary" as const },
		{ membershipId: ALICE, name: "Alice", position: "treasurer" as const },
		{ membershipId: BOB, name: "Bob", position: "president" as const },
	];

	it("is keyed on (member, OFFICE), so a dual-office holder can be half done", () => {
		// Alice counts 1 toward the four, yet her Treasurer seat is still open.
		// That is the prompt a club wants, and it is why the display grain is
		// narrower than the scoring grain.
		const records = [rec(ALICE, "secretary", 1)];
		expect(untrainedSeats(seats, records, 1).map((s) => s.position)).toEqual([
			"treasurer",
			"president",
		]);
		expect(countTrainedOfficers(records, 1)).toBe(1);
	});

	it("ignores records from the other period", () => {
		expect(untrainedSeats(seats, [rec(BOB, "president", 2)], 1)).toHaveLength(
			3,
		);
		expect(untrainedSeats(seats, [rec(BOB, "president", 2)], 2)).toHaveLength(
			2,
		);
	});

	it("returns nothing when every seat is covered", () => {
		const records = [
			rec(ALICE, "secretary", 1),
			rec(ALICE, "treasurer", 1),
			rec(BOB, "president", 1),
		];
		expect(untrainedSeats(seats, records, 1)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The tally the UI renders
// ---------------------------------------------------------------------------

describe("tallyPeriod", () => {
	it("reports an absolute shortfall and the required bar", () => {
		const t = tallyPeriod(
			P1_2026,
			true,
			[rec(ALICE, "president", 1), rec(BOB, "secretary", 1)],
			"2026-08-10",
		);
		expect(t.trained).toBe(2);
		expect(t.required).toBe(4);
		expect(t.shortfall).toBe(2);
		expect(t.met).toBe(false);
		expect(t.phase).toBe("open");
		expect(t.daysUntilClose).toBe(21);
		expect(t.windowIsDefault).toBe(true);
	});

	it("floors the shortfall at zero when over the bar", () => {
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "vp_education", 1),
			rec(CARA, "secretary", 1),
			rec(DAN, "treasurer", 1),
			rec(ERIN, "sergeant_at_arms", 1),
		];
		const t = tallyPeriod(P1_2026, false, records, "2026-08-10");
		expect(t.trained).toBe(5);
		expect(t.shortfall).toBe(0);
		expect(t.met).toBe(true);
		expect(t.windowIsDefault).toBe(false);
	});

	it("reports a closed window with a shortfall — the #531 failure state", () => {
		const t = tallyPeriod(
			P1_2026,
			true,
			[
				rec(ALICE, "president", 1),
				rec(BOB, "secretary", 1),
				rec(CARA, "treasurer", 1),
			],
			"2026-09-15",
		);
		expect(t.phase).toBe("closed");
		expect(t.daysUntilClose).toBeNull();
		expect(t.trained).toBe(3);
		expect(t.shortfall).toBe(1);
		expect(t.met).toBe(false);
	});
});

describe("focusPeriod", () => {
	const tallies = (today: string) =>
		defaultTrainingWindows(2026).map((w) => tallyPeriod(w, true, [], today));

	it("leads with the open window", () => {
		expect(focusPeriod(tallies("2026-07-15"))).toBe(1);
		expect(focusPeriod(tallies("2026-12-15"))).toBe(2);
	});

	it("leads with the next upcoming window between the two", () => {
		// Sep–Oct: period 1 shut, period 2 not yet open.
		expect(focusPeriod(tallies("2026-10-01"))).toBe(2);
	});

	it("leads with period 2 once the year is done", () => {
		expect(focusPeriod(tallies("2027-05-01"))).toBe(2);
	});

	it("leads with period 1 before the year has started", () => {
		expect(focusPeriod(tallies("2026-01-01"))).toBe(1);
	});
});
