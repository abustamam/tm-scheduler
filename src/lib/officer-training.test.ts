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
import { goalByKey } from "./dcp";
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
	isWindowOrderValid,
	suggestG9,
	TRAINABLE_OFFICER_POSITIONS,
	TRAINED_OFFICERS_REQUIRED,
	TRAINING_GOAL_KEY,
	TRAINING_PERIODS,
	type TrainingRecordLike,
	tallyPeriod,
	todayIso,
	trainingAppliedMessage,
	trainingApplyLabel,
	trainingPeriodLabel,
	trainingProgramYearForDate,
	trainingSuggestionNote,
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

	it("counts to the END of a window that has not opened yet", () => {
		// The deadline the club is racing is the CLOSE, not the open. Returning
		// days-until-OPEN instead was green across all three suites: the unit tests
		// only probed dates inside the window, the integration test asserted the
		// upcoming PHASE but not its number, and the panel takes the number as a
		// literal prop.
		// 2026-05-01 → 2026-08-31 is 122 days.
		expect(daysUntilClose(P1_2026, "2026-05-01")).toBe(122);
		expect(daysUntilClose(P1_2026, "2026-05-31")).toBe(92);
	});
});

describe("trainingProgramYearForDate", () => {
	// The whole point: it differs from `programYearForDate` in exactly one month.
	it("names the NEXT program year through the whole of June", () => {
		// Jun 15 2027 sits inside period 1 of program year 2027
		// (2027-06-01..2027-08-31), while currentProgramYear() still says 2026,
		// whose windows both closed months earlier. Pinning the panel to the
		// latter showed "Closed / Closed" in the month officers are trained.
		expect(trainingProgramYearForDate(new Date(2027, 5, 15))).toBe(2027);
		expect(trainingProgramYearForDate(new Date(2027, 5, 1))).toBe(2027);
		expect(trainingProgramYearForDate(new Date(2027, 5, 30))).toBe(2027);
	});

	it("agrees with the program year in every other month", () => {
		// July–December → that calendar year.
		expect(trainingProgramYearForDate(new Date(2027, 6, 1))).toBe(2027);
		expect(trainingProgramYearForDate(new Date(2027, 11, 31))).toBe(2027);
		// January–May → the previous one. March–May genuinely have no open
		// window, so reading them as the old year is correct, not a gap.
		expect(trainingProgramYearForDate(new Date(2027, 0, 1))).toBe(2026);
		expect(trainingProgramYearForDate(new Date(2027, 1, 28))).toBe(2026);
		expect(trainingProgramYearForDate(new Date(2027, 4, 31))).toBe(2026);
	});

	it("returns a year whose period 1 window actually contains the date", () => {
		// Stated as the property rather than as a formula, so a re-derivation that
		// happens to produce the same numbers for the cases above still has to be
		// right about the thing that matters.
		const june = new Date(2027, 5, 15);
		const py = trainingProgramYearForDate(june);
		expect(windowPhase(defaultTrainingWindow(py, 1), todayIso(june))).toBe(
			"open",
		);
	});
});

describe("isWindowOrderValid", () => {
	it("accepts an in-order window, including a single day", () => {
		expect(isWindowOrderValid("2026-06-01", "2026-08-31")).toBe(true);
		expect(isWindowOrderValid("2026-06-01", "2026-06-01")).toBe(true);
	});

	it("rejects a back-to-front window", () => {
		expect(isWindowOrderValid("2026-08-31", "2026-06-01")).toBe(false);
	});

	it("rejects an EMPTY bound — the half a bare comparison gets wrong", () => {
		// `"2026-08-31" < ""` is FALSE, so a plain `endsOn < startsOn` called a
		// cleared start date VALID and left the form's Save button live on a
		// request the server always rejects, with a raw ZodError as the toast.
		expect("2026-08-31" < "").toBe(false);
		expect(isWindowOrderValid("", "2026-08-31")).toBe(false);
		expect(isWindowOrderValid("2026-06-01", "")).toBe(false);
		expect(isWindowOrderValid("", "")).toBe(false);
	});
});

describe("the apply affordance's words", () => {
	// These exist as functions precisely so this test can exist. As ternaries in
	// the route they were unreachable: no test mounts a route, typecheck sees two
	// strings either way, and mutation swapped the polarity with 150/150 green.
	it("labels the button with the value the click will WRITE", () => {
		expect(trainingApplyLabel(1)).toBe("Apply training records (mark met)");
		expect(trainingApplyLabel(0)).toBe("Apply training records (mark not met)");
	});

	it("reports what was actually stored, matching polarity", () => {
		expect(trainingAppliedMessage(1)).toBe(
			"Goal 9 marked met from your officer training records.",
		);
		expect(trainingAppliedMessage(0)).toBe(
			"Goal 9 set to not met from your officer training records.",
		);
	});

	it("keeps the two labels distinct, so a swap cannot pass", () => {
		expect(trainingApplyLabel(1)).not.toBe(trainingApplyLabel(0));
		expect(trainingAppliedMessage(1)).not.toBe(trainingAppliedMessage(0));
	});

	it("puts period 1 FIRST in the badge — the order IS the information", () => {
		// The badge is the only surface telling the club WHICH window is short.
		expect(trainingSuggestionNote([4, 3])).toBe("Training: 4 and 3 of 4");
		expect(trainingSuggestionNote([3, 4])).toBe("Training: 3 and 4 of 4");
		expect(trainingSuggestionNote([4, 3])).not.toBe(
			trainingSuggestionNote([3, 4]),
		);
	});

	it("renders zeros for a missing period rather than 'undefined'", () => {
		expect(trainingSuggestionNote([])).toBe("Training: 0 and 0 of 4");
		expect(trainingSuggestionNote([2])).toBe("Training: 2 and 0 of 4");
	});
});

describe("TRAINING_GOAL_KEY", () => {
	it("really names the composite TRAINING goal in the DCP catalog", () => {
		// The key is a second spelling of `DCP_GOALS[].key`, so this is what keeps
		// the two honest. Without it a catalog renumber would leave the route
		// picking the group by category and the row by this key — two selectors
		// disagreeing — while `expect(TRAINING_GOAL_KEY).toBe("g9")` still passed.
		const goal = goalByKey(TRAINING_GOAL_KEY);
		expect(goal).toBeDefined();
		expect(goal?.category).toBe("training");
		expect(goal?.composite).toBe(true);
		expect(goal?.target).toBe(1);
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

	it("passes a SHAPE-invalid string through rather than rendering NaN", () => {
		expect(formatIsoDate("not a date")).toBe("not a date");
		expect(formatIsoDate("")).toBe("");
	});

	it("overflow-rolls a shape-valid but impossible date, which is unreachable", () => {
		// `formatCalendarDay`'s contract is "returns the input unchanged if it is
		// not a plain date", where plain means the YYYY-MM-DD SHAPE — so
		// `2026-13-01` is formatted, and `Date.UTC(2026, 12, 1)` rolls it into
		// 2027. Asserted rather than hidden, because it differs from the
		// hand-rolled formatter this replaced (which returned the input), and the
		// difference is only acceptable because the value cannot get here:
		// the default windows are code-derived, a stored bound comes from a
		// Postgres `date` column which refuses month 13 outright, and
		// `isoDateSchema` rejects calendar-invalid dates on the way in
		// (`src/server/officer-training-logic.ts`, covered in its own suite).
		expect(formatIsoDate("2026-13-01")).toBe("Jan 1, 2027");
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
// Counting: distinct OFFICES
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
	// The four shapes that decide the rule, each with an ABSOLUTE expected value.
	// Never `toBe(TRAINED_OFFICERS_REQUIRED)` or a comparison against it: an
	// expectation written in terms of the constant passes for every value of the
	// constant, including one that reintroduces the bug (CLAUDE.md's own trap).
	//
	//   Shape                    | TI credits | offices | people (the old rule)
	//   4 people, 4 offices      |          4 |       4 | 4
	//   4 people, all Secretary  |          1 |       1 | 4   <- over-counted
	//   1 person,  2 offices     |          2 |       2 | 1   <- under-counted
	//   2 people,  4 offices     |          4 |       4 | 2   <- under-counted

	it("SHAPE 1 — four people in four offices counts 4", () => {
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "vp_education", 1),
			rec(CARA, "secretary", 1),
			rec(DAN, "treasurer", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(4);
		expect(isPeriodMet(countTrainedOfficers(records, 1))).toBe(true);
	});

	it("SHAPE 2 — four people all trained as Secretary counts 1", () => {
		// TI: "credit is given only for one person per officer role." Counting
		// people read this as 4 and suggested goal 9 MET where TI credits one —
		// the over-count the whole rule exists to prevent. Reachable: the unique
		// index is (membership, office, year, period), so any number of members
		// may each claim the same office.
		const records = [
			rec(ALICE, "secretary", 1),
			rec(BOB, "secretary", 1),
			rec(CARA, "secretary", 1),
			rec(DAN, "secretary", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(1);
		expect(isPeriodMet(countTrainedOfficers(records, 1))).toBe(false);
	});

	it("SHAPE 3 — one person trained for two offices counts 2", () => {
		// The double-hatting small club. Counting people said 1, and
		// min(people, offices) also said 1, because the people ceiling had no
		// basis in TI's rule and could only subtract. TI credits both roles.
		const records = [rec(ALICE, "secretary", 1), rec(ALICE, "treasurer", 1)];
		expect(countTrainedOfficers(records, 1)).toBe(2);
	});

	it("SHAPE 4 — two people covering four offices counts 4", () => {
		// Same mechanism as shape 3, at the bar. President also VPE, Secretary
		// also Treasurer: normal below about fifteen members, and TI credits four
		// roles. The people ceiling reported 2 and told the club it had failed.
		const records = [
			rec(ALICE, "president", 1),
			rec(ALICE, "vp_education", 1),
			rec(BOB, "secretary", 1),
			rec(BOB, "treasurer", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(4);
		expect(isPeriodMet(countTrainedOfficers(records, 1))).toBe(true);
	});

	it("de-dups repeat records for the same office", () => {
		// Two people plus a duplicate claim on one of their offices — still two
		// roles. This is the de-dup itself, separate from shape 2's headline case.
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "president", 1),
			rec(CARA, "secretary", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(2);
	});

	it("ignores an Immediate Past President record entirely", () => {
		// The untrainable office is dropped BEFORE the de-dup, so it can never be
		// the fourth role. Counting it would clear the bar on three real ones.
		const records = [
			rec(ALICE, "president", 1),
			rec(BOB, "vp_education", 1),
			rec(CARA, "secretary", 1),
			rec(ERIN, "immediate_past_president", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(3);
		expect(isPeriodMet(countTrainedOfficers(records, 1))).toBe(false);
	});

	it("counts a person's OTHER office when their IPP row is dropped", () => {
		const records = [
			rec(ALICE, "immediate_past_president", 1),
			rec(ALICE, "treasurer", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(1);
	});

	it("counts an IPP-only club as zero", () => {
		expect(
			countTrainedOfficers([rec(ERIN, "immediate_past_president", 1)], 1),
		).toBe(0);
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

	it("can reach all seven offices, and stops there", () => {
		// The ceiling is TI's seven elected offices, so a club cannot manufacture
		// an eighth role by recording IPP alongside them.
		const records = [
			...TRAINABLE_OFFICER_POSITIONS.map((p) => rec(ALICE, p, 1)),
			rec(BOB, "immediate_past_president", 1),
		];
		expect(countTrainedOfficers(records, 1)).toBe(7);
	});

	it("is zero for an empty record set", () => {
		expect(countTrainedOfficers([], 1)).toBe(0);
		expect(countTrainedOfficers([], 2)).toBe(0);
	});

	it("counts a DUPLICATED human's two memberships as the offices they cover", () => {
		// `guards.ts` notes one human can hold two `members` rows in a club (only
		// through two Person rows — `members_club_person_unique` makes membership
		// and person 1:1). Under the office rule that is no longer a counting
		// hazard at all: two rows for one human on two different offices are two
		// roles, which is what TI credits.
		const dupA = "aaaa1111-1111-1111-1111-111111111111";
		const dupB = "bbbb2222-2222-2222-2222-222222222222";
		const records = [rec(dupA, "secretary", 1), rec(dupB, "treasurer", 1)];
		expect(countTrainedOfficers(records, 1)).toBe(2);
	});
});

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

	it("suggests 1 for a double-hatting club that covers four roles per period", () => {
		// Three people covering four offices in each period. TI credits four roles
		// per period, so this club HAS cleared goal 9 — and under the previous
		// people rule it was told the opposite, in the club shape that is normal
		// below about fifteen members. The inversion of this expectation is the
		// whole point of the change; asserted at the suggestion level so the fix
		// is pinned end to end, not only inside countTrainedOfficers.
		const perPeriod = (period: 1 | 2) => [
			rec(ALICE, "secretary", period),
			rec(ALICE, "treasurer", period),
			rec(BOB, "president", period),
			rec(CARA, "vp_education", period),
		];
		expect(suggestG9([...perPeriod(1), ...perPeriod(2)])).toBe(1);
	});

	it("still suggests 0 when a period's four records cover only one role", () => {
		// The over-count guard, at the suggestion level: four people all trained
		// as Secretary is one role, so the period is not met and goal 9 is not
		// suggested however many records exist.
		const four = (period: 1 | 2) => [
			rec(ALICE, "president", period),
			rec(BOB, "vp_education", period),
			rec(CARA, "secretary", period),
			rec(DAN, "treasurer", period),
		];
		const oneRole = [
			rec(ALICE, "secretary", 2),
			rec(BOB, "secretary", 2),
			rec(CARA, "secretary", 2),
			rec(DAN, "secretary", 2),
		];
		expect(suggestG9([...four(1), ...oneRole])).toBe(0);
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
