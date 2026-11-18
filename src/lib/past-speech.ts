// Pure rules for a speech given outside any meeting (#1656): its loose date,
// the validation shared by add and edit, and where it sorts in the speech log.
// No db import, so the client sheet and the unit tests reach it.

export const PAST_SPEECH_MIN_YEAR = 1900;

export const PAST_SPEECH_TITLE_REQUIRED_MESSAGE =
	"A past speech needs a title.";
export const PAST_SPEECH_MONTH_NEEDS_YEAR_MESSAGE =
	"Pick a year before a month.";
export const PAST_SPEECH_FUTURE_MESSAGE =
	"A past speech can't be dated in the future.";
export const PAST_SPEECH_NOT_PAST_MESSAGE = "Not a past speech.";

/** The calendar year and month (1-12) "now" falls in, in an IANA zone (UTC when none). */
export function currentYearMonthIn(
	now: Date,
	timezone: string | null,
): { year: number; month: number } {
	const utc = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone ?? "UTC",
			year: "numeric",
			month: "numeric",
		}).formatToParts(now);
		const year = Number(parts.find((p) => p.type === "year")?.value);
		const month = Number(parts.find((p) => p.type === "month")?.value);
		return Number.isInteger(year) && Number.isInteger(month)
			? { year, month }
			: utc;
	} catch {
		return utc;
	}
}

/** The calendar year "now" falls in, in an IANA zone (UTC when none). */
export function currentYearIn(now: Date, timezone: string | null): number {
	return currentYearMonthIn(now, timezone).year;
}

/**
 * Validate and normalize a loose delivery date. Both parts are optional; a
 * month needs a year; a year runs from 1900 to the current year in the
 * recording club's timezone (UTC when the club is gone), and in the current
 * year the month may not be after the current month.
 */
export function validatePastSpeechDate(args: {
	year?: number | null;
	month?: number | null;
	now: Date;
	timezone: string | null;
}): { year: number | null; month: number | null } {
	const year = args.year ?? null;
	const month = args.month ?? null;
	if (month !== null && year === null) {
		throw new Error(PAST_SPEECH_MONTH_NEEDS_YEAR_MESSAGE);
	}
	if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) {
		throw new Error("The month must be 1 to 12.");
	}
	if (year !== null) {
		const current = currentYearMonthIn(args.now, args.timezone);
		const max = current.year;
		if (!Number.isInteger(year) || year < PAST_SPEECH_MIN_YEAR) {
			throw new Error(`The year must be ${PAST_SPEECH_MIN_YEAR} or later.`);
		}
		if (year > max) {
			throw new Error(PAST_SPEECH_FUTURE_MESSAGE);
		}
		if (year === max && month !== null && month > current.month) {
			throw new Error(PAST_SPEECH_FUTURE_MESSAGE);
		}
	}
	return { year, month };
}

/** A past speech's blank-or-real title check; "TBA" is not a title. */
export function requirePastSpeechTitle(title: string | undefined): void {
	const t = (title ?? "").trim();
	if (t === "" || t.toUpperCase() === "TBA") {
		throw new Error(PAST_SPEECH_TITLE_REQUIRED_MESSAGE);
	}
}

/**
 * The instant a past speech sorts at: the first of its month, or Jan 1 of its
 * year, both UTC (it has no timezone). Null when undated.
 */
export function pastSpeechSortInstant(
	year: number | null,
	month: number | null,
): number | null {
	if (year === null) return null;
	return Date.UTC(year, month === null ? 0 : month - 1, 1);
}

export type MergeableLogRow =
	| { kind: "meeting"; slotId: string; scheduledAt: Date | string }
	| {
			kind: "past";
			speechId: string;
			deliveredYear: number | null;
			deliveredMonth: number | null;
			createdAt: Date | string;
	  };

function ms(d: Date | string): number {
	return new Date(d).getTime();
}

function idOf(r: MergeableLogRow): string {
	return r.kind === "meeting" ? r.slotId : r.speechId;
}

/**
 * Newest first. Dated rows by instant (a meeting row beats a past row on an
 * equal instant); then undated past rows last. Ties between past rows: newer
 * `createdAt`, then larger id.
 */
export function compareSpeechLogRows(
	a: MergeableLogRow,
	b: MergeableLogRow,
): number {
	const ka =
		a.kind === "meeting"
			? ms(a.scheduledAt)
			: pastSpeechSortInstant(a.deliveredYear, a.deliveredMonth);
	const kb =
		b.kind === "meeting"
			? ms(b.scheduledAt)
			: pastSpeechSortInstant(b.deliveredYear, b.deliveredMonth);
	if (ka === null && kb !== null) return 1;
	if (kb === null && ka !== null) return -1;
	if (ka !== null && kb !== null && ka !== kb) return kb - ka;
	if (a.kind !== b.kind) return a.kind === "meeting" ? -1 : 1;
	if (a.kind === "past" && b.kind === "past") {
		const c = ms(b.createdAt) - ms(a.createdAt);
		if (c !== 0) return c;
	}
	const ia = idOf(a);
	const ib = idOf(b);
	return ia === ib ? 0 : ia < ib ? 1 : -1;
}
