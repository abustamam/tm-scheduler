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
