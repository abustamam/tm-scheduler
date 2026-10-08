// What the Area Director's view shows for a club (#1117, part of #1115): the
// rules that turn raw counts into a value, or into "not tracked".
//
// Pure and client-safe: no `#/db`, no server import. `area-health-logic.ts`
// counts rows and hands the totals to `deriveClubHealth`; every decision about
// what a total MEANS lives here, so it is unit-testable without a database and
// the server module is left with SQL and nothing else.
//
// NUMBERS, NEVER PEOPLE. Nothing in this file (and nothing it returns) names a
// person. The totals come in as counts; the one place identity-shaped ids enter
// is `TrainingRecordLike.membershipId`, which `countTrainedOfficers` accepts to
// satisfy its input type and never reads for the count.
//
// "NOT TRACKED" IS NOT ZERO. A club that has never taken a roll has not
// "averaged 0 members"; it has not told us. Every field is `Tracked<T>`, so a
// reader cannot show a zero for something nobody recorded. That is the whole
// reason for the wrapper: an Area Director comparing six clubs must be able to
// tell a quiet club from one that does not use a feature.
import { computeDcpSummary } from "#/lib/dcp";
import { selectActivePeriodId } from "#/lib/dues";
import {
	countTrainedOfficers,
	defaultTrainingWindow,
	type IsoDate,
	TRAINABLE_OFFICER_POSITIONS,
	TRAINING_PERIODS,
	type TrainingPeriod,
	type TrainingRecordLike,
	type TrainingWindow,
	todayIso,
	trainingProgramYearForDate,
	windowPhase,
} from "#/lib/officer-training";

// ---------------------------------------------------------------------------
// The shapes the area view receives
// ---------------------------------------------------------------------------

/** A number, or the fact that the club does not record it. */
export type Tracked<T> = { tracked: true; value: T } | { tracked: false };

const NOT_TRACKED = { tracked: false } as const;

/**
 * `on_gavelup`: a linked, live club. `not_on_gavelup`: a name-only row, or a row
 * whose club was permanently deleted. `archived`: a linked club that has been
 * archived. The last two carry no data.
 */
export type ClubHealthStatus = "on_gavelup" | "not_on_gavelup" | "archived";

export interface ClubHealth {
	/** The `area_clubs` row, NOT the club: a name-only row has no club. */
	areaClubId: string;
	name: string;
	clubNumber: string | null;
	status: ClubHealthStatus;
	meetings: Tracked<{
		held: number;
		cancelled: number;
		daysSinceLast: number | null;
		/** ISO instants, soonest first, at most {@link NEXT_MEETINGS_SHOWN}. */
		next: string[];
	}>;
	roleFillRate: Tracked<{ filled: number; total: number }>;
	attendance: Tracked<{
		avgMembers: number;
		avgGuests: number;
		rollTaken: number;
		held: number;
	}>;
	officers: Tracked<{
		seatsFilled: number;
		seatsTotal: number;
		trained: Tracked<number>;
	}>;
	dcp: Tracked<{ goalsMet: number }>;
	renewals: Tracked<{ paidThisPeriod: number; paidLastPeriod: number }>;
}

export interface AreaHealth {
	areaId: string;
	/** The area as people say it: division letter then area number, "C3". */
	label: string;
	programYear: number;
	/** The instant the numbers were read, ISO. */
	asOf: string;
	clubs: ClubHealth[];
}

// ---------------------------------------------------------------------------
// Time: held, recent, days since
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** How far back "recent" reaches. */
export const RECENT_WINDOW_DAYS = 90;

/** How many upcoming meetings the view lists per club. */
export const NEXT_MEETINGS_SHOWN = 2;

/**
 * The first instant that counts as "recent": exactly 90 x 24h before `now`.
 *
 * Instants, not calendar days. A meeting is "recent" when
 * `scheduled_at >= recentWindowStart(now)` and `scheduled_at < now`; the lower
 * bound is INCLUSIVE and `now` is EXCLUSIVE, which is also what separates a
 * "held" meeting (`scheduled_at < now`) from an upcoming one (`>= now`), so a
 * meeting is never both. A calendar subtraction would move this bound by an
 * hour twice a year in any server timezone that observes DST.
 *
 * A "held" meeting is one whose status is not `cancelled` and whose
 * `scheduled_at` is before `now`. The SQL in `area-health-logic.ts` states that
 * predicate and calls this for its bound.
 */
export function recentWindowStart(now: Date): Date {
	return new Date(now.getTime() - RECENT_WINDOW_DAYS * DAY_MS);
}

/**
 * Whole days from `then` to `now`: the floor of the difference over 24h. 23h59m
 * is 0 days, 24h is 1. Callers pass a held meeting, so `then < now`.
 */
export function wholeDaysSince(then: Date, now: Date): number {
	return Math.floor((now.getTime() - then.getTime()) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Officer training: which period to read
// ---------------------------------------------------------------------------

/**
 * Both training windows for a club-year: the stored override for a period where
 * one exists, else TI's own dates (`defaultTrainingWindow`). Per period, not per
 * club: a club that edited only period 2 still has the default period 1.
 */
export function resolveTrainingWindows(
	programYear: number,
	overrides: readonly TrainingWindow[],
): TrainingWindow[] {
	return TRAINING_PERIODS.map(
		(period) =>
			overrides.find((o) => o.period === period) ??
			defaultTrainingWindow(programYear, period),
	);
}

/**
 * The training period the area view counts, chosen the same way for every club.
 *
 * Overrides may overlap, or both start later (`setTrainingWindowSchema` checks
 * each window's own order and nothing across the two), so "the open one" is not
 * always one window and not always present:
 *
 * 1. the highest-numbered OPEN window; else
 * 2. the highest-numbered CLOSED window (between windows, or both shut); else
 * 3. period 1, when no window has started.
 */
export function chooseTrainingPeriod(
	windows: readonly TrainingWindow[],
	today: IsoDate,
): TrainingPeriod {
	const highest = (phase: "open" | "closed"): TrainingPeriod | null =>
		windows
			.filter((w) => windowPhase(w, today) === phase)
			.reduce<TrainingPeriod | null>(
				(best, w) => (best === null || w.period > best ? w.period : best),
				null,
			);
	return highest("open") ?? highest("closed") ?? 1;
}

// ---------------------------------------------------------------------------
// Renewals: which period, and the one before it
// ---------------------------------------------------------------------------

/** A dues period with the number of paid-or-waived `member_dues` rows against it. */
export interface DuesPeriodFacts {
	id: string;
	dueDate: Date;
	createdAt: Date;
	/** Rows for the period. `dues_status` has only `paid` and `waived`. */
	paid: number;
}

function byDueDateThenCreatedThenId(
	a: DuesPeriodFacts,
	b: DuesPeriodFacts,
): number {
	return (
		a.dueDate.getTime() - b.dueDate.getTime() ||
		a.createdAt.getTime() - b.createdAt.getTime() ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/**
 * Renewals this period against the period before it.
 *
 * "This period" is whatever `selectActivePeriodId` picks, the same call the
 * club's own Treasurer view makes. It falls back to the EARLIEST period when
 * every period is still upcoming, so having two periods is not enough to have a
 * predecessor: the active period must have one before it. Periods are ordered by
 * `due_date`, then `created_at`, then `id`, so two periods due the same day have
 * a stable "before".
 */
export function renewalsHealth(
	periods: readonly DuesPeriodFacts[],
	now: Date,
): Tracked<{ paidThisPeriod: number; paidLastPeriod: number }> {
	const ordered = [...periods].sort(byDueDateThenCreatedThenId);
	const activeId = selectActivePeriodId(ordered, now);
	if (activeId === null) return NOT_TRACKED;
	const at = ordered.findIndex((p) => p.id === activeId);
	const active = ordered[at];
	const previous = ordered[at - 1];
	if (!active || !previous) return NOT_TRACKED;
	return {
		tracked: true,
		value: { paidThisPeriod: active.paid, paidLastPeriod: previous.paid },
	};
}

// ---------------------------------------------------------------------------
// One club
// ---------------------------------------------------------------------------

/** What the area view knows about a club before any number is read. */
export interface ClubIdentity {
	areaClubId: string;
	name: string;
	clubNumber: string | null;
	status: ClubHealthStatus;
}

/**
 * The totals `area-health-logic.ts` counts for one GavelUp club. Counts and
 * instants only.
 */
export interface ClubHealthData {
	meetings: {
		/** Meetings the club has ever had, any status, any date. */
		rows: number;
		/** Held, in the recent window. */
		recentHeld: number;
		/** Cancelled, in the recent window. */
		recentCancelled: number;
		/** The latest held meeting ever, or null. */
		lastHeldAt: Date | null;
		/** Upcoming non-cancelled meetings, soonest first. */
		next: readonly Date[];
	};
	/** Slots at the recent held meetings: `filled` is claimed or confirmed. */
	slots: { filled: number; total: number };
	/**
	 * Over recent held meetings that have at least one `meeting_attendance` row:
	 * how many such meetings, and the `present` rows summed across them.
	 */
	attendance: {
		rollTaken: number;
		presentMembers: number;
		presentGuests: number;
	};
	/** Distinct trainable offices with an open term on an active member. */
	officerSeatsFilled: number;
	training: {
		/** `officer_training_records` rows the club has, any year. */
		recordRows: number;
		/** The records of the training program year. */
		records: readonly TrainingRecordLike[];
		/** The club's stored windows for that year, possibly none. */
		overrides: readonly TrainingWindow[];
	};
	/** goalKey to achieved, or null when the club has no scoreboard this year. */
	dcpProgress: Record<string, number> | null;
	duesPeriods: readonly DuesPeriodFacts[];
}

/** Every field untracked: a club with nothing to read. */
function untracked(club: ClubIdentity): ClubHealth {
	return {
		areaClubId: club.areaClubId,
		name: club.name,
		clubNumber: club.clubNumber,
		status: club.status,
		meetings: NOT_TRACKED,
		roleFillRate: NOT_TRACKED,
		attendance: NOT_TRACKED,
		officers: NOT_TRACKED,
		dcp: NOT_TRACKED,
		renewals: NOT_TRACKED,
	};
}

/**
 * One club's health. A club that is not `on_gavelup`, or that has no `data`,
 * has every field untracked, `officers` included: an archived club's officers
 * are not the area's business, and a name-only club has none to count.
 */
export function deriveClubHealth(
	club: ClubIdentity,
	data: ClubHealthData | null,
	now: Date,
): ClubHealth {
	if (club.status !== "on_gavelup" || data === null) return untracked(club);
	const { meetings, slots, attendance } = data;

	// The recent held meetings are the denominator of two rules below.
	const heldRecently = meetings.recentHeld;

	const trainingYear = trainingProgramYearForDate(now);
	const period = chooseTrainingPeriod(
		resolveTrainingWindows(trainingYear, data.training.overrides),
		todayIso(now),
	);

	return {
		...untracked(club),
		meetings:
			meetings.rows === 0
				? NOT_TRACKED
				: {
						tracked: true,
						value: {
							held: heldRecently,
							cancelled: meetings.recentCancelled,
							daysSinceLast:
								meetings.lastHeldAt === null
									? null
									: wholeDaysSince(meetings.lastHeldAt, now),
							next: meetings.next
								.slice(0, NEXT_MEETINGS_SHOWN)
								.map((d) => d.toISOString()),
						},
					},
		roleFillRate:
			heldRecently === 0 || slots.total === 0
				? NOT_TRACKED
				: {
						tracked: true,
						value: { filled: slots.filled, total: slots.total },
					},
		attendance:
			attendance.rollTaken === 0
				? NOT_TRACKED
				: {
						tracked: true,
						value: {
							avgMembers: attendance.presentMembers / attendance.rollTaken,
							avgGuests: attendance.presentGuests / attendance.rollTaken,
							rollTaken: attendance.rollTaken,
							held: heldRecently,
						},
					},
		// Always tracked for a GavelUp club: an empty officer list is a number.
		officers: {
			tracked: true,
			value: {
				seatsFilled: data.officerSeatsFilled,
				seatsTotal: TRAINABLE_OFFICER_POSITIONS.length,
				trained:
					data.training.recordRows === 0
						? NOT_TRACKED
						: {
								tracked: true,
								value: countTrainedOfficers(data.training.records, period),
							},
			},
		},
		dcp:
			data.dcpProgress === null
				? NOT_TRACKED
				: {
						tracked: true,
						// `goalsMet` reads only the stored progress. The member count and
						// the base do not enter it, so neither is looked up here.
						value: {
							goalsMet: computeDcpSummary({
								progress: data.dcpProgress,
								currentActive: 0,
								baseMemberCount: null,
							}).goalsMet,
						},
					},
		renewals: renewalsHealth(data.duesPeriods, now),
	};
}

// ---------------------------------------------------------------------------
// The area
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<ClubHealthStatus, number> = {
	on_gavelup: 0,
	not_on_gavelup: 1,
	archived: 2,
};

/**
 * Clubs on GavelUp first, then clubs that are not, then archived ones; by name
 * within each, numbers compared as numbers ("Club 2" before "Club 10"). The row
 * id is the last key so two clubs with one name always sort the same way.
 */
export function sortClubHealth(clubs: readonly ClubHealth[]): ClubHealth[] {
	return [...clubs].sort(
		(a, b) =>
			STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
			a.name.localeCompare(b.name, "en", {
				numeric: true,
				sensitivity: "base",
			}) ||
			(a.areaClubId < b.areaClubId ? -1 : a.areaClubId > b.areaClubId ? 1 : 0),
	);
}
