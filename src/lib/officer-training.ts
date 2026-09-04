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
 * TI words the bar over ROLES. This app counts **distinct PEOPLE** — a member
 * holding two offices counts ONCE toward the four (maintainer decision,
 * 2026-09-04). That is deliberately the conservative reading: it can only
 * UNDER-count relative to TI, so the app can never tell a club it cleared goal 9
 * when TI would disagree. TI, not GavelUp, is the system of record for who got
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

/** Type guard for a stored/`z.input` period value. */
export function isTrainingPeriod(value: unknown): value is TrainingPeriod {
	return value === 1 || value === 2;
}

/** Display label for a period ("First period" / "Second period"). */
export function trainingPeriodLabel(period: TrainingPeriod): string {
	return period === 1 ? "First period" : "Second period";
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/**
 * The DCP goal these records feed — `DCP_GOALS[8].key` in `#/lib/dcp`. Named
 * once so the apply path, the scoreboard badge and the guard test all spell the
 * same key: a bare `"g9"` in three files is three chances to write `"g10"` and
 * silently move the composite administration goal instead.
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

const MONTH_ABBREVIATIONS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/**
 * `2026-06-01` → `Jun 1, 2026`. Formatted from the STRING's own parts, never by
 * constructing a `Date`: `new Date("2026-06-01")` is parsed as UTC midnight and
 * `toLocaleDateString` then renders it in local time, printing "May 31" for
 * every viewer west of Greenwich. That is the one bug a window bound cannot
 * afford, since the bound IS the deadline being displayed.
 */
export function formatIsoDate(iso: IsoDate): string {
	if (!isIsoDate(iso)) return iso;
	const month = MONTH_ABBREVIATIONS[Number(iso.slice(5, 7)) - 1];
	if (!month) return iso;
	return `${month} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
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

/** Both TI default windows for a program year, in chronological order. */
export function defaultTrainingWindows(programYear: number): TrainingWindow[] {
	return TRAINING_PERIODS.map((p) => defaultTrainingWindow(programYear, p));
}

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

/** The fields of a training record the scoring rules actually read. */
export interface TrainingRecordLike {
	/** The `members` row (a person in THIS club), the unit the bar counts. */
	membershipId: string;
	/** The office the club claims this person was trained for. */
	position: OfficerPosition;
	period: TrainingPeriod;
}

/**
 * Officers trained in a period — **distinct people**, not distinct offices.
 *
 * Two filters, both load-bearing and neither derivable from the other:
 * `period` (a record credits exactly one of the two windows) and
 * {@link isTrainablePosition} (an Immediate Past President record counts for
 * nothing, per TI's list of seven). Records whose office is untrainable are
 * dropped BEFORE the de-dup, so a person holding only that office contributes 0
 * rather than 1.
 */
export function countTrainedOfficers(
	records: readonly TrainingRecordLike[],
	period: TrainingPeriod,
): number {
	const people = new Set<string>();
	for (const r of records) {
		if (r.period !== period) continue;
		if (!isTrainablePosition(r.position)) continue;
		people.add(r.membershipId);
	}
	return people.size;
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
	/** Distinct PEOPLE with a record in this period. */
	trained: number;
	/** Always {@link TRAINED_OFFICERS_REQUIRED}; carried so the UI needn't import it. */
	required: number;
	met: boolean;
	/** How many more distinct people are needed (0 once met). */
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
