import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/;

export type ParsedMeetingKey =
	| { kind: "date"; date: string }
	| { kind: "instant"; date: string; hh: string; mm: string }
	| { kind: "uuid"; id: string }
	| { kind: "invalid" };

/** Classify a `$meetingId` URL segment: a club-local date, a date+HHmm instant,
 *  a raw uuid, or invalid. Shape-only — validity is decided by resolution. */
export function parseMeetingKey(key: string): ParsedMeetingKey {
	const m = key.match(DATE_KEY_RE);
	if (m) {
		const [, date, hh, mm] = m;
		return hh && mm
			? { kind: "instant", date, hh, mm }
			: { kind: "date", date };
	}
	if (UUID_RE.test(key)) return { kind: "uuid", id: key };
	return { kind: "invalid" };
}

/** The club-local calendar date (YYYY-MM-DD) of a UTC instant. */
export function localDateKey(instant: Date, timeZone: string): string {
	return utcToZonedWallTime(instant, timeZone).slice(0, 10);
}

/** Canonical URL key: the club-local date, suffixed with -HHmm (local 24h) only
 *  when another meeting shares that local date. */
export function meetingUrlKey(
	scheduledAt: Date,
	timeZone: string,
	collides: boolean,
): string {
	const wall = utcToZonedWallTime(scheduledAt, timeZone); // YYYY-MM-DDTHH:mm
	const date = wall.slice(0, 10);
	if (!collides) return date;
	return `${date}-${wall.slice(11, 13)}${wall.slice(14, 16)}`;
}

/** Next calendar-date label (YYYY-MM-DD). tz-independent — operates on the label. */
export function nextCalendarDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The UTC [start, end) window for a club-local calendar date. */
export function localDayRange(
	date: string,
	timeZone: string,
): { start: Date; end: Date } {
	return {
		start: zonedWallTimeToUtc(`${date}T00:00`, timeZone),
		end: zonedWallTimeToUtc(`${nextCalendarDate(date)}T00:00`, timeZone),
	};
}

/** Assign canonical urlKeys to a list, detecting collisions WITHIN the list
 *  (same club-local date ⇒ all suffixed). Returns id → urlKey. */
export function urlKeysForMeetings(
	items: { id: string; scheduledAt: Date | string }[],
	timeZone: string,
): Map<string, string> {
	const dateOf = (i: { scheduledAt: Date | string }) =>
		localDateKey(new Date(i.scheduledAt), timeZone);
	const counts = new Map<string, number>();
	for (const i of items) {
		const d = dateOf(i);
		counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	const out = new Map<string, string>();
	for (const i of items) {
		out.set(
			i.id,
			meetingUrlKey(
				new Date(i.scheduledAt),
				timeZone,
				(counts.get(dateOf(i)) ?? 0) >= 2,
			),
		);
	}
	return out;
}
