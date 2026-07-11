/**
 * Pure, db-free recurrence generator for batch-creating meetings (#184).
 *
 * ALL calendar logic lives here so it can be unit-tested in isolation AND run
 * client-side to power the editable preview (no `#/db` import). It works purely
 * in the club's LOCAL wall calendar: it emits `YYYY-MM-DD` dates + a fixed
 * time-of-day. Converting a wall time to the actual UTC instant (DST-correct)
 * is the caller's job via `zonedWallTimeToUtc` — keeping that seam out of here
 * is what makes a batch spanning a DST change keep the same wall-clock time.
 */

/** Hard cap on how many meetings a single batch may generate. */
export const MAX_BATCH = 52;

/**
 * A monthly ordinal: the Nth weekday of the month, or the last one.
 * The UI offers {1,2,3,4,"last"}; the generator also understands 5 so a
 * "5th <weekday>" request is correctly OMITTED in months that lack a 5th
 * (never shifted) — the canonical "non-existent ordinal" case.
 */
export type Ordinal = 1 | 2 | 3 | 4 | 5 | "last";

/** Weekday index, 0 = Sunday … 6 = Saturday (matches `Date.getUTCDay()`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** How many meetings to generate: a fixed count, or up to an inclusive date. */
export type RecurrenceBound =
	| { kind: "count"; count: number }
	| { kind: "until"; until: string }; // YYYY-MM-DD, inclusive

interface RecurrenceBase {
	/** First date to consider (YYYY-MM-DD), in the club timezone. */
	startDate: string;
	/** Time of day applied to every generated date (HH:mm), club-local wall time. */
	timeOfDay: string;
	bound: RecurrenceBound;
}

/** Every N weeks on a chosen weekday (N=1 weekly, 2 biweekly, …). */
export interface IntervalRecurrence extends RecurrenceBase {
	mode: "interval";
	weekday: Weekday;
	/** N in "every N weeks". Must be ≥ 1. */
	intervalWeeks: number;
}

/** A weekday on one-or-more monthly ordinals, e.g. "2nd & 4th Thursday". */
export interface MonthlyRecurrence extends RecurrenceBase {
	mode: "monthly";
	weekday: Weekday;
	/** Which ordinals to emit each month; order irrelevant (canonicalised). */
	ordinals: Ordinal[];
}

export type RecurrenceInput = IntervalRecurrence | MonthlyRecurrence;

/** A single generated occurrence in the club's local calendar. */
export interface Occurrence {
	/** Local calendar date, YYYY-MM-DD. */
	date: string;
	/** Full wall-clock datetime-local string (`${date}T${timeOfDay}`). */
	wallTime: string;
	/** Weekday of `date`, 0 = Sunday … 6 = Saturday. */
	weekday: Weekday;
}

export interface GenerateResult {
	occurrences: Occurrence[];
	/** True when the 52-cap truncated a set the inputs would have grown past. */
	clamped: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) =>
	`${y}-${pad(m0 + 1)}-${pad(d)}`;

/** Parse a YYYY-MM-DD string into calendar parts. Throws on a malformed value. */
function parseDate(s: string): { y: number; m0: number; d: number } {
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) throw new Error("Invalid date.");
	return { y: Number(m[1]), m0: Number(m[2]) - 1, d: Number(m[3]) };
}

/** Days in a given month (m0 is 0-based). */
function daysInMonth(y: number, m0: number): number {
	return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** Weekday (0–6) of a calendar date, computed timezone-free via a UTC anchor. */
function weekdayOf(y: number, m0: number, d: number): Weekday {
	return new Date(Date.UTC(y, m0, d)).getUTCDay() as Weekday;
}

/**
 * The day-of-month for the Nth (or last) `weekday` in a month, or null when
 * that ordinal does not occur (e.g. a 5th weekday in a month with only four).
 */
function ordinalDay(
	y: number,
	m0: number,
	weekday: Weekday,
	ordinal: Ordinal,
): number | null {
	const dim = daysInMonth(y, m0);
	if (ordinal === "last") {
		const lastDow = weekdayOf(y, m0, dim);
		return dim - ((lastDow - weekday + 7) % 7);
	}
	const firstDow = weekdayOf(y, m0, 1);
	const firstMatch = 1 + ((weekday - firstDow + 7) % 7);
	const day = firstMatch + (ordinal - 1) * 7;
	return day <= dim ? day : null;
}

/** Canonical ascending order for ordinals within a month (1..5 then last). */
const ORDINAL_ORDER: Ordinal[] = [1, 2, 3, 4, 5, "last"];

/**
 * Lazily yield candidate calendar dates (ascending) for the given recurrence,
 * ignoring the bound — the bound is applied by `generateOccurrences`.
 */
function* candidateDates(
	input: RecurrenceInput,
): Generator<{ y: number; m0: number; d: number }> {
	const start = parseDate(input.startDate);
	const startKey = start.y * 10000 + start.m0 * 100 + start.d;

	if (input.mode === "interval") {
		const step = Math.max(1, Math.floor(input.intervalWeeks)) * 7;
		// First occurrence: the first date on/after startDate on the weekday.
		let cur = new Date(Date.UTC(start.y, start.m0, start.d));
		const offset = (input.weekday - cur.getUTCDay() + 7) % 7;
		cur = new Date(cur.getTime() + offset * 86400000);
		// Safety ceiling so a degenerate caller can never spin forever.
		for (let i = 0; i < MAX_BATCH + 1; i++) {
			yield {
				y: cur.getUTCFullYear(),
				m0: cur.getUTCMonth(),
				d: cur.getUTCDate(),
			};
			cur = new Date(cur.getTime() + step * 86400000);
		}
		return;
	}

	// Monthly ordinals. Walk months from startDate's month forward, emitting the
	// requested ordinals (deduped, in ascending date order) that fall on/after
	// startDate. A month-boundary gap (e.g. 4th → next 2nd) is therefore the real
	// ~3-week gap, NOT a naive 14-day step.
	const ordinals = ORDINAL_ORDER.filter((o) => input.ordinals.includes(o));
	let y = start.y;
	let m0 = start.m0;
	// Enough months to reach 52 occurrences even at one ordinal per month.
	for (let month = 0; month <= MAX_BATCH + 1; month++) {
		const seen = new Set<number>();
		for (const ord of ordinals) {
			const day = ordinalDay(y, m0, input.weekday, ord);
			if (day == null) continue; // ordinal doesn't occur this month — omit
			if (seen.has(day)) continue; // e.g. 4th === last in a 4-week month
			seen.add(day);
			const key = y * 10000 + m0 * 100 + day;
			if (key < startKey) continue; // before the start date
			yield { y, m0, d: day };
		}
		m0 += 1;
		if (m0 > 11) {
			m0 = 0;
			y += 1;
		}
	}
}

/**
 * Generate the ordered occurrences for a recurrence, honouring the bound and
 * the hard 52-cap. Non-existent ordinals are omitted (never shifted). Returns
 * `clamped: true` when the cap cut off occurrences the inputs would have added.
 */
export function generateOccurrences(input: RecurrenceInput): GenerateResult {
	const limit =
		input.bound.kind === "count"
			? Math.min(Math.max(0, Math.floor(input.bound.count)), MAX_BATCH)
			: MAX_BATCH;
	const untilKey =
		input.bound.kind === "until"
			? (() => {
					const u = parseDate(input.bound.until);
					return u.y * 10000 + u.m0 * 100 + u.d;
				})()
			: null;

	const occurrences: Occurrence[] = [];
	let clamped = false;

	for (const c of candidateDates(input)) {
		const key = c.y * 10000 + c.m0 * 100 + c.d;
		if (untilKey != null && key > untilKey) break; // natural end (until)

		if (occurrences.length >= limit) {
			// A further valid candidate exists but the bound/cap stops us.
			if (input.bound.kind === "until") {
				clamped = true; // capped before reaching the until-date
			} else if (input.bound.count > MAX_BATCH) {
				clamped = true; // asked for more than the cap allows
			}
			break;
		}

		const date = ymd(c.y, c.m0, c.d);
		occurrences.push({
			date,
			wallTime: `${date}T${input.timeOfDay}`,
			weekday: weekdayOf(c.y, c.m0, c.d),
		});
	}

	return { occurrences, clamped };
}

/** Short weekday labels for preview rendering, indexed 0 = Sun … 6 = Sat. */
export const WEEKDAY_LABELS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

/** Human labels for the ordinal picker, in canonical order. */
export const ORDINAL_OPTIONS: { value: Ordinal; label: string }[] = [
	{ value: 1, label: "1st" },
	{ value: 2, label: "2nd" },
	{ value: 3, label: "3rd" },
	{ value: 4, label: "4th" },
	{ value: "last", label: "last" },
];
