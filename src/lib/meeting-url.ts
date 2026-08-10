import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/;

export type ParsedMeetingKey =
	| { kind: "date"; date: string }
	| { kind: "instant"; date: string; hh: string; mm: string }
	| { kind: "uuid"; id: string }
	| { kind: "invalid" };

/**
 * True when `YYYY-MM-DD` names a date that actually exists on the calendar.
 *
 * The shape regex cannot do this: `\d{2}` matches `31` in a 30-day month and
 * `99` in any month. `Date.UTC` then OVERFLOW-ROLLS the excess instead of
 * rejecting it, so the impossible label silently becomes a real instant —
 * `2026-09-31` → 2026-10-01. Round-tripping through `Date.UTC` and comparing
 * the rendered label back to the input is what catches that: a rolled date
 * renders as a DIFFERENT label than the one supplied.
 */
function isRealCalendarDate(date: string): boolean {
	const [y, m, d] = date.split("-").map(Number);
	const t = Date.UTC(y, m - 1, d);
	return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date;
}

/**
 * Classify a `$meetingId` URL segment: a club-local date, a date+HHmm instant,
 * a raw uuid, or invalid.
 *
 * Shape AND calendar validity. The original design (#336) made this shape-only,
 * on the recorded reasoning that an impossible date would simply "find no
 * meeting → notFound()". That premise was false: `localDayRange` feeds the
 * label to `Date.UTC`, which rolls `2026-09-31` to October 1 and happily
 * resolves OCTOBER'S meeting. A wrong-but-plausible date is a realistic typo
 * (September has 30 days), and the failure was silent — a working page for a
 * meeting the visitor did not ask for, which on the ballot means voting in it.
 * Rejecting here fixes every caller at once rather than each resolution site.
 */
export function parseMeetingKey(key: string): ParsedMeetingKey {
	const m = key.match(DATE_KEY_RE);
	if (m) {
		const [, date, hh, mm] = m;
		if (!isRealCalendarDate(date)) return { kind: "invalid" };
		// Same reasoning one level down: `-2599` is shape-valid and would be fed
		// to `zonedWallTimeToUtc`, which rolls 25:99 into the next day rather
		// than rejecting it.
		if (hh && mm && (Number(hh) > 23 || Number(mm) > 59)) {
			return { kind: "invalid" };
		}
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
