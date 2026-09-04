/**
 * Pure, client-safe Club Officer Training (COT) helpers — the record behind DCP
 * goal 9 (#531).
 *
 * NO `#/db` import lives here, for BOTH of the reasons CLAUDE.md records. The
 * bundle reason: `src/server/officer-training-logic.ts` and the admin route
 * share this module, and a `#/db` import would drag `pg` → `Buffer` into the
 * browser. The testability reason matters more here, because the substance of
 * this change IS a set of numbers — the four-officer bar and the two window
 * dates. A constant living in a `-logic.ts` module cannot be imported by a unit
 * test at all (`DATABASE_URL is not set` at load), so it could be raised to
 * anything with the suite green. They live here so `officer-training.test.ts`
 * can assert them ABSOLUTELY.
 *
 * ## Source of the rules
 *
 * Toastmasters International, *Distinguished Club Program and Club Success Plan*
 * (item 1111), Goal 9; cross-checked against District 206
 * (`d206tm.org/resources/for-clubs/club-officer-training`). Both retrieved
 * 2026-08-07.
 *
 * > A minimum of four club officer roles trained during each of the two training
 * > periods. […] at least four of its officer roles — Club President, Vice
 * > President Education, Vice President Membership, Vice President Public
 * > Relations, Club Secretary, Club Treasurer, and Sergeant at Arms — are
 * > trained in their responsibilities. […] credit is given only for one person
 * > per officer role.
 *
 * > The first training session occurs between June 1 and August 31, and the
 * > second is held between November 1 and February 28 (or February 29 in leap
 * > years).
 *
 * ## What the bar counts here, and why it disagrees with that quote
 *
 * TI words the bar over ROLES and adds that credit goes to one person per role.
 * The maintainer's decision (2026-09-04) was to count distinct PEOPLE, so a
 * member holding two offices counts ONCE. Taking that alone was wrong in the
 * other direction — two people trained for the SAME office counted twice where
 * TI credits one — so the bar is **the smaller of distinct people and distinct
 * offices**. See {@link countTrainedOfficers}, which is where that rule lives
 * and where the reasoning is written out in full. Both ceilings together are
 * what make "can only under-count relative to TI" true rather than intended. TI, not GavelUp, is the system of record for who got
 * trained, which is also why nothing here writes goal 9 — the derivation is a
 * SUGGESTION the President applies (ADR-0019, third assist beside the roster
 * assist for goals 7/8 and the Pathways assist for goals 1–6, #245).
 *
 * Seat-level display is keyed on (membership, office) instead, so a dual-office
 * holder trained for one of their two offices reads as trained on that seat and
 * untrained on the other — while still counting 1. The two grains are different
 * on purpose: {@link countTrainedOfficers} scores, {@link untrainedSeats}
 * displays.
 */
import { programYearForDate } from "#/lib/dcp";
import { formatCalendarDay } from "#/lib/format";
import { OFFICER_POSITIONS, type OfficerPosition } from "#/lib/officers";

// ---------------------------------------------------------------------------
// The two training periods
// ---------------------------------------------------------------------------

/**
 * TI runs exactly two training periods per program year. Stored as a plain
 * integer (`officer_training_records.period` /
 * `officer_training_periods.period`) rather than an enum so the natural ordering
 * IS the chronological one.
 */
export const TRAINING_PERIODS = [1, 2] as const;
export type TrainingPeriod = (typeof TRAINING_PERIODS)[number];

/**
 * Type guard for a stored / request period value, derived from
 * {@link TRAINING_PERIODS} rather than re-spelling `1 || 2`. It is what
 * `periodSchema` in `officer-training-logic.ts` validates with, so the domain
 * has one declaration in TypeScript and one in SQL (the two `CHECK`s) instead of
 * four.
 */
export function isTrainingPeriod(value: unknown): value is TrainingPeriod {
	return (TRAINING_PERIODS as readonly unknown[]).includes(value);
}

/** Display label for a period ("First period" / "Second period"). */
export function trainingPeriodLabel(period: TrainingPeriod): string {
	return period === 1 ? "First period" : "Second period";
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/**
 * The DCP goal these records feed. Named once so the apply path, the scoreboard
 * badge and the guard all spell the same key: a bare `"g9"` in three files is
 * three chances to write `"g10"` and silently move the composite ADMINISTRATION
 * goal instead.
 *
 * A literal rather than a lookup, because `#/lib/dcp`'s catalog is the source of
 * truth for the goal and this is a second spelling of its key. What keeps the
 * two honest is an assertion, not this comment: `officer-training.test.ts`
 * checks `goalByKey(TRAINING_GOAL_KEY)` really is the composite TRAINING goal.
 * Without it a catalog renumber (TI reorders, `g9` becomes administration) would
 * leave the route picking the GROUP by `category === "training"` and the ROW by
 * this key — two selectors quietly disagreeing, the badge rendering against no
 * row, and `expect(TRAINING_GOAL_KEY).toBe("g9")` still passing.
 */
export const TRAINING_GOAL_KEY = "g9";

/**
 * Four officers per period, per TI. An ABSOLUTE constant asserted absolutely in
 * the tests: a test written as `expect(trained).toBeLessThanOrEqual(REQUIRED)`
 * passes for every value of REQUIRED, including one that reintroduces the bug
 * this issue closes.
 */
export const TRAINED_OFFICERS_REQUIRED = 4;

/**
 * The officer roles TI counts toward goal 9 — the seven elected offices.
 * `immediate_past_president` is carried by `officerPositionEnum` but is NOT in
 * TI's list, so it is excluded: it is a courtesy title, not an elected office
 * with training attached.
 */
export const TRAINABLE_OFFICER_POSITIONS: readonly OfficerPosition[] =
	OFFICER_POSITIONS.filter((p) => p !== "immediate_past_president");

/** Does this office count toward goal 9? False for Immediate Past President. */
export function isTrainablePosition(position: OfficerPosition): boolean {
	return TRAINABLE_OFFICER_POSITIONS.includes(position);
}

// ---------------------------------------------------------------------------
// ISO calendar dates
// ---------------------------------------------------------------------------

/**
 * A calendar date as `YYYY-MM-DD`. Stored via drizzle `date(..., { mode:
 * "string" })` and passed over the RPC boundary as this string, never as a
 * `Date`: a window bound is a calendar day with no instant attached, and a
 * `Date` at local midnight becomes a UTC instant that shifts the day for half
 * the world. Lexicographic order on this format IS chronological order, so
 * comparisons need no parsing.
 */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape check for a `YYYY-MM-DD` string (not a calendar-validity check). */
export function isIsoDate(value: unknown): value is IsoDate {
	return typeof value === "string" && ISO_DATE.test(value);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Build `YYYY-MM-DD` from calendar parts (month is 1-based). */
export function isoDateOf(year: number, month: number, day: number): IsoDate {
	return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/**
 * "Today" as the viewer's LOCAL calendar date. Local rather than UTC because a
 * club reading "the window closes in 3 days" means its own calendar; a UTC
 * reading is a day off for anyone west of Greenwich for most of their day.
 */
export function todayIso(now: Date = new Date()): IsoDate {
	return isoDateOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Days since the epoch for a `YYYY-MM-DD` date, parsed as UTC noon-free. */
function epochDay(iso: IsoDate): number {
	const year = Number(iso.slice(0, 4));
	const month = Number(iso.slice(5, 7));
	const day = Number(iso.slice(8, 10));
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Whole days from `from` to `to` (negative when `to` is earlier). Both bounds
 * are parsed as UTC, so the result is exact and never off-by-one across a DST
 * boundary — which a local-midnight `Date` subtraction is, twice a year.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
	return epochDay(to) - epochDay(from);
}

/**
 * `2026-06-01` → `Jun 1, 2026`, for a window bound that has to name its year.
 *
 * A thin alias over `formatCalendarDay` (`#/lib/format`, #529) rather than an
 * implementation: that function already solves this exact problem — a calendar
 * day put through `new Date("2026-06-01")` is UTC midnight and formats as
 * "May 31" for every viewer west of Greenwich, disagreeing between the SSR
 * container and the hydrated client — and it does it with a UTC-pinned `Intl`
 * formatter, so it is locale-aware where a hand-rolled month table is
 * English-only. #531 shipped that hand-rolled table first, two files from the
 * function whose doc comment carries the same reasoning; this is the reuse it
 * should have been.
 */
export function formatIsoDate(iso: IsoDate): string {
	return formatCalendarDay(iso, { withYear: true });
}

/** Gregorian leap year — needed for period 2's Feb 28 vs Feb 29 end date. */
export function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// ---------------------------------------------------------------------------
// Training windows
// ---------------------------------------------------------------------------

export interface TrainingWindow {
	period: TrainingPeriod;
	/** Inclusive first day. */
	startsOn: IsoDate;
	/** Inclusive last day. */
	endsOn: IsoDate;
}

/**
 * TI's own dates for a period of the given program year (`program_year` is the
 * STARTING calendar year of the Jul 1 – Jun 30 year — see `#/lib/dcp`).
 *
 * - Period 1: **Jun 1 – Aug 31 of `programYear`**
 * - Period 2: **Nov 1 of `programYear` – Feb 28/29 of `programYear + 1`**
 *
 * Note period 1 STRADDLES the program-year boundary backwards: Jun 1 of
 * `programYear` is a month before that program year begins, because TI trains
 * incoming officers just before their term starts. That is TI's design, not an
 * off-by-one here, and it is why a window is scoped to `(club, program_year,
 * period)` rather than clipped to `programYearWindow()`.
 *
 * These are DEFAULTS, not the truth: a district may deviate, and only a stored
 * row can make the "window closes in three weeks" reading honest. A club with no
 * stored row gets these, so no club has to type dates in to get value.
 */
export function defaultTrainingWindow(
	programYear: number,
	period: TrainingPeriod,
): TrainingWindow {
	if (period === 1) {
		return {
			period,
			startsOn: isoDateOf(programYear, 6, 1),
			endsOn: isoDateOf(programYear, 8, 31),
		};
	}
	const endYear = programYear + 1;
	return {
		period,
		startsOn: isoDateOf(programYear, 11, 1),
		endsOn: isoDateOf(endYear, 2, isLeapYear(endYear) ? 29 : 28),
	};
}

/**
 * Both TI default windows for a program year, in chronological order. Used by
 * the DCP route to ask whether ANY window is open right now (the June banner's
 * honesty check) and by the tests.
 */
export function defaultTrainingWindows(programYear: number): TrainingWindow[] {
	return TRAINING_PERIODS.map((p) => defaultTrainingWindow(programYear, p));
}

/**
 * The program year whose TRAINING windows "today" sits in — which is NOT always
 * `currentProgramYear()`, and the gap is a whole month of silence.
 *
 * `currentProgramYear` rolls on Jul 1. Period 1 opens Jun 1 of the year it
 * belongs to. So through the whole of June, `currentProgramYear()` names the
 * year whose windows are BOTH already shut and final, while period 1 of the next
 * program year is open right now — the month incoming officers are actually
 * being trained. Measured for 2027-06-15: `currentProgramYear()` = 2026, whose
 * windows are `2026-06-01..2026-08-31` (closed) and `2026-11-01..2027-02-28`
 * (closed), while `2027-06-01..2027-08-31` is OPEN.
 *
 * Pinning the panel to `currentProgramYear()` therefore showed both windows
 * Closed with no countdown for all of June — exactly the "two of four and three
 * weeks left" reading #531 exists to give — and a club that recorded June
 * training anyway filed it against the PREVIOUS year's goal 9, already scored,
 * where it also came back flagged "outside this window".
 *
 * June is the ONLY month the two disagree. March–May read as shut and genuinely
 * are (last year's period 2 closed end of February, this year's period 1 has not
 * opened), so they are left alone.
 */
export function trainingProgramYearForDate(now: Date = new Date()): number {
	// getMonth() is 0-based, so 5 is June.
	return now.getMonth() === 5 ? now.getFullYear() : programYearForDate(now);
}

/**
 * Is a proposed window the right way round? One declaration, so the form, the
 * zod refinement and any future reader state the rule once. The db CHECK
 * (`officer_training_periods_order_check`) is a deliberate extra copy — the only
 * one a raw `sql` write cannot bypass.
 *
 * An EMPTY bound is invalid, which is the half a bare `endsOn < startsOn` gets
 * wrong: with `startsOn` cleared, `"2026-08-31" < ""` is FALSE, so the naive
 * predicate called an empty start valid and left the form's Save button live on
 * a request the server always rejects — with a raw `ZodError` JSON array as the
 * toast.
 */
export function isWindowOrderValid(startsOn: string, endsOn: string): boolean {
	if (!startsOn || !endsOn) return false;
	return endsOn >= startsOn;
}

/** The one wording for a back-to-front window, shared by the form and the seam. */
export const WINDOW_ORDER_MESSAGE =
	"The window must end on or after it starts.";

/** Where "today" sits relative to a window. Both bounds are INCLUSIVE. */
export type WindowPhase = "upcoming" | "open" | "closed";

export function windowPhase(
	window: TrainingWindow,
	today: IsoDate,
): WindowPhase {
	if (today < window.startsOn) return "upcoming";
	if (today > window.endsOn) return "closed";
	return "open";
}

/**
 * Days left before the window shuts, or null once it has. Counted INCLUSIVELY
 * of the last day, so 0 means "closes today" and 1 means "closes tomorrow" —
 * never "already too late" for a day the club can still act on. For an upcoming
 * window this is the days until its END (the deadline the club is racing), which
 * is what the nudge and the badge both want.
 */
export function daysUntilClose(
	window: TrainingWindow,
	today: IsoDate,
): number | null {
	const left = daysBetween(today, window.endsOn);
	return left < 0 ? null : left;
}

/**
 * Is a recorded training date outside the window of the period it claims credit
 * for? Null (date not recorded) is NOT an offence — a club often knows an
 * officer was trained without knowing the day, and forcing a date would push
 * them to invent one. The score ignores this flag entirely: an out-of-window row
 * still counts, because the club's claim is what it is and TI is the arbiter.
 * The view surfaces it so the club can see the mismatch instead of it being
 * silently absorbed.
 */
export function isOutsideWindow(
	trainedOn: IsoDate | null,
	window: TrainingWindow,
): boolean {
	if (trainedOn == null) return false;
	return trainedOn < window.startsOn || trainedOn > window.endsOn;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * The fields of a training record the scoring and display rules read.
 *
 * ## Why `membershipId` and NOT `members.person_id`
 *
 * Adversarial review argued the count should de-dup on `person_id`, because
 * "one human can hold two `members` rows in the SAME club" (`guards.ts` says
 * exactly that). The claim is true and the fix does nothing, which is worth
 * writing down so it is not re-litigated: `members_club_person_unique` is a
 * unique index on `(club_id, person_id)`, so WITHIN a club membership and person
 * are 1:1 — the state `guards.ts` describes is reached "through two Person
 * rows", i.e. two DIFFERENT person ids. A duplicated human therefore counts
 * twice under either key, and no key can fix it; only merging the two Person
 * rows can, which is what `collapseMemberships` is for.
 *
 * The supporting argument was wrong in the same way. It read the merge REDUCING
 * a club's count from 2 to 1 as proof the key was wrong. That reduction is
 * correct and is the point of a merge: there was only ever one human, and the
 * count is over people.
 */
export interface TrainingRecordLike {
	/**
	 * The `members` row. The unit {@link countTrainedOfficers} de-dups on (1:1
	 * with the person inside a club, per the note above) and the unit
	 * {@link untrainedSeats} keys on with the office.
	 */
	membershipId: string;
	/** The office the club claims this person was trained for. */
	position: OfficerPosition;
	period: TrainingPeriod;
}

/**
 * Officers trained in a period, floored to what TI could possibly credit:
 * **the smaller of distinct PEOPLE and distinct OFFICES**.
 *
 * Two filters first, both load-bearing and neither derivable from the other:
 * `period` (a record credits exactly one of the two windows) and
 * {@link isTrainablePosition} (an Immediate Past President record counts for
 * nothing, per TI's list of seven). Records whose office is untrainable are
 * dropped BEFORE the de-dup, so a person holding only that office contributes 0
 * rather than 1.
 *
 * ## Why BOTH ceilings, when the decision was "distinct people"
 *
 * The maintainer's rule is distinct people, chosen because it "can only
 * under-count relative to TI, so a club is never told it cleared goal 9 when TI
 * would disagree" (2026-09-04). That reasoning holds in one direction and fails
 * in the other, and taking people alone would have made the guarantee FALSE:
 *
 * - One person, two offices → TI credits 2 roles, people says 1. Under-counts,
 *   as intended.
 * - **Two people, one office → TI credits 1 role** ("credit is given only for
 *   one person per officer role" — the manual is explicit), people says 2.
 *   OVER-counts, which is the direction the rule exists to prevent.
 *
 * The second shape is reachable, not theoretical: the unique index is
 * (membership, office, year, period), so any number of members may each claim
 * `secretary`, and the panel offers all seven offices to any active member on
 * purpose (someone may have been trained for an office they have since handed
 * on). Four members recorded against one office read "4/4 · Bar cleared" and
 * suggested goal 9 MET where TI credits one role.
 *
 * `Math.min` honours the decision rather than reversing it: the result is never
 * more than distinct people (the rule as given) and never more than distinct
 * offices (TI's own cap), so "can only under-count" becomes true instead of
 * merely intended. For the settled dual-office example the answer is unchanged.
 */
export function countTrainedOfficers(
	records: readonly TrainingRecordLike[],
	period: TrainingPeriod,
): number {
	const people = new Set<string>();
	const offices = new Set<OfficerPosition>();
	for (const r of records) {
		if (r.period !== period) continue;
		if (!isTrainablePosition(r.position)) continue;
		people.add(r.membershipId);
		offices.add(r.position);
	}
	return Math.min(people.size, offices.size);
}

/** Is a period's four-officer bar cleared? */
export function isPeriodMet(trained: number): boolean {
	return trained >= TRAINED_OFFICERS_REQUIRED;
}

/**
 * The goal-9 SUGGESTION: 1 only when BOTH periods clear the bar, else 0. Goal 9
 * is composite (ADR-0019 §3) so the stored value is a 0/1 toggle; this is the
 * value an Apply would write, and nothing writes it without one.
 */
export function suggestG9(records: readonly TrainingRecordLike[]): number {
	return TRAINING_PERIODS.every((p) =>
		isPeriodMet(countTrainedOfficers(records, p)),
	)
		? 1
		: 0;
}

// ---------------------------------------------------------------------------
// The words the apply affordance says
// ---------------------------------------------------------------------------
//
// These three live HERE, as pure functions of a number, for one reason: in the
// route they were ternaries, and a ternary between two strings is invisible to
// every gate this repo has. A route cannot be mounted in vitest, typecheck sees
// two strings whichever way round they are, and the source guard could only
// assert that both strings appear SOMEWHERE. Mutation review swapped the button
// labels and the toast polarity together and the whole suite stayed green at
// 150/150 — so the President would have clicked "mark met" and watched goal 9 go
// to not-met, with a toast confirming the opposite of what happened, in the one
// affordance #531 exists to add. As functions they are unit-tested against
// literals and an inversion fails a real test.

/**
 * The apply button's label. Names the value the click will WRITE, because this
 * action can lower a stored value: a generic "Apply" would make clearing a
 * hand-entered Met look like setting one.
 */
export function trainingApplyLabel(suggestion: number): string {
	return suggestion === 1
		? "Apply training records (mark met)"
		: "Apply training records (mark not met)";
}

/** The toast after an apply, describing what was actually stored. */
export function trainingAppliedMessage(stored: number): string {
	return stored === 1
		? "Goal 9 marked met from your officer training records."
		: "Goal 9 set to not met from your officer training records.";
}

/**
 * The dashed badge beside goal 9: "Training: 4 and 3 of 4".
 *
 * Order is [period 1, period 2] and that ORDER is the information — it is the
 * only surface telling the club WHICH of the two windows is short, which is the
 * single fact #531 exists to deliver. Swapping the two reads as plausible and
 * was green under mutation while it lived in the route as a destructuring.
 */
export function trainingSuggestionNote(
	trainedByPeriod: readonly number[],
): string {
	const [first = 0, second = 0] = trainedByPeriod;
	return `Training: ${first} and ${second} of ${TRAINED_OFFICERS_REQUIRED}`;
}

// ---------------------------------------------------------------------------
// The per-period view model
// ---------------------------------------------------------------------------

/** One currently-held office, the unit the "who is not trained" list shows. */
export interface OfficerSeat {
	membershipId: string;
	name: string;
	position: OfficerPosition;
}

/**
 * Seats with no record for this period, keyed on (membership, OFFICE) — the
 * display grain, deliberately narrower than the scoring grain. A dual-office
 * holder trained for one office appears here for the other, which is the
 * prompt a club wants ("Secretary is covered, Treasurer is not") even though
 * they already count 1 toward the four.
 */
export function untrainedSeats(
	seats: readonly OfficerSeat[],
	records: readonly TrainingRecordLike[],
	period: TrainingPeriod,
): OfficerSeat[] {
	const covered = new Set<string>();
	for (const r of records) {
		if (r.period !== period) continue;
		covered.add(`${r.membershipId}:${r.position}`);
	}
	return seats.filter((s) => !covered.has(`${s.membershipId}:${s.position}`));
}

export interface TrainingPeriodTally {
	period: TrainingPeriod;
	window: TrainingWindow;
	/** false → the window is a stored, club-edited override of TI's dates. */
	windowIsDefault: boolean;
	phase: WindowPhase;
	/** Inclusive days left before the window shuts; null once closed. */
	daysUntilClose: number | null;
	/** The scored count: the smaller of distinct people and distinct offices. */
	trained: number;
	/** Always {@link TRAINED_OFFICERS_REQUIRED}; carried so the UI needn't import it. */
	required: number;
	met: boolean;
	/**
	 * How many more the period needs (0 once met). Moving it takes one more
	 * person AND one more office, since {@link countTrainedOfficers} is the min
	 * of the two — recording a fifth person against an office already trained
	 * changes nothing.
	 */
	shortfall: number;
}

/** Roll one period's window + records into the tally the UI renders. */
export function tallyPeriod(
	window: TrainingWindow,
	windowIsDefault: boolean,
	records: readonly TrainingRecordLike[],
	today: IsoDate,
): TrainingPeriodTally {
	const trained = countTrainedOfficers(records, window.period);
	const met = isPeriodMet(trained);
	return {
		period: window.period,
		window,
		windowIsDefault,
		phase: windowPhase(window, today),
		daysUntilClose: daysUntilClose(window, today),
		trained,
		required: TRAINED_OFFICERS_REQUIRED,
		met,
		shortfall: Math.max(0, TRAINED_OFFICERS_REQUIRED - trained),
	};
}

/**
 * Is this period the one to lead with? The first period that is still OPEN,
 * else the first that is upcoming, else period 2 (both closed — the year is
 * done). Never null, so the UI has no empty state to invent.
 */
export function focusPeriod(
	tallies: readonly TrainingPeriodTally[],
): TrainingPeriod {
	const open = tallies.find((t) => t.phase === "open");
	if (open) return open.period;
	const upcoming = tallies.find((t) => t.phase === "upcoming");
	if (upcoming) return upcoming.period;
	return 2;
}
