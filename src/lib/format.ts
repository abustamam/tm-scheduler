export function formatMeetingDate(value: Date | string, timeZone?: string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone,
	}).format(d);
}

export function formatMeetingTime(value: Date | string, timeZone?: string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	}).format(d);
}

/**
 * Render a meeting's time as a start–end range, deriving the end from the
 * meeting length (minutes). Used wherever a meeting's time is shown so the
 * schedule/agenda communicates when the meeting finishes, not just when it
 * starts. Falls back to start-only when `lengthMinutes` is missing/non-positive.
 */
export function formatMeetingTimeRange(
	value: Date | string,
	lengthMinutes: number | null | undefined,
	timeZone?: string,
) {
	const start = typeof value === "string" ? new Date(value) : value;
	if (!lengthMinutes || lengthMinutes <= 0) {
		return formatMeetingTime(start, timeZone);
	}
	const end = new Date(start.getTime() + lengthMinutes * 60_000);
	return `${formatMeetingTime(start, timeZone)} – ${formatMeetingTime(end, timeZone)}`;
}

/**
 * A meeting's date including the YEAR. For history surfaces (the past-meetings
 * archive, #375) where the list spans years and `formatMeetingDate`'s
 * year-less "Thu, Jul 23" is ambiguous.
 */
export function formatArchiveDate(value: Date | string, timeZone?: string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone,
	}).format(d);
}

export function formatShortDate(value: Date | string, timeZone?: string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		timeZone,
	}).format(d);
}

/**
 * Format a CALENDAR DAY ("YYYY-MM-DD") as e.g. "Aug 10", or "Aug 10, 2026" with
 * `{ withYear: true }`.
 *
 * Deliberately not `formatShortDate`, which would take the same string through
 * `new Date("2026-08-10")` — UTC midnight — and then format it in the runtime's
 * zone, printing "Aug 9" for every club west of UTC and disagreeing between the
 * SSR pass (UTC container) and the hydrated client. Pinning both the
 * construction and the formatting to UTC makes the day survive the round trip
 * unchanged, whoever is looking and wherever the process runs.
 *
 * `withYear` was added by #531, whose training-window bounds span two calendar
 * years ("Nov 1, 2026 – Feb 28, 2027") and are meaningless without it. It is an
 * option here rather than a second function because the UTC pinning above is the
 * whole point and a parallel implementation would drop it — which is exactly what
 * #531 did first, hand-rolling an English month table in
 * `officer-training.ts` while this function sat two files away carrying the same
 * reasoning in its own doc comment.
 *
 * Returns the input unchanged if it is not a plain date, so a bad value shows up
 * rather than becoming "Invalid Date".
 */
export function formatCalendarDay(
	ymd: string,
	options?: { withYear?: boolean },
) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
	if (!m) return ymd;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		...(options?.withYear ? { year: "numeric" as const } : {}),
		timeZone: "UTC",
	}).format(d);
}
