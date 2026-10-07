/**
 * What the meeting forms open on (#1086): the standing schedule, then its
 * latest meeting, then fixed fallbacks, decided PER FIELD. Pure and
 * db-free; `today` is injected so a test never reads the clock.
 */

import { effectiveLocation } from "#/lib/effective-location";
import {
	generateOccurrences,
	type Ordinal,
	type Weekday,
} from "#/lib/meeting-recurrence";
import {
	addDays,
	buildTopUpRecurrenceInput,
	fmtYmd,
	parseOrdinal,
	parseYmd,
	type StoredRecurrenceRule,
} from "#/lib/recurrence-rule";

export interface MeetingFormDefaults {
	mode: "interval" | "monthly";
	weekday: Weekday;
	intervalWeeks: number;
	ordinals: Ordinal[];
	/** HH:mm, club-local. */
	timeOfDay: string;
	/** YYYY-MM-DD, club-local: the first open date. */
	startDate: string;
	/** "" when nothing is known. */
	location: string;
}

const FALLBACK_WEEKDAY: Weekday = 2;
const FALLBACK_TIME = "19:00";
const FALLBACK_ORDINALS: Ordinal[] = [2, 4];

const shiftYmd = (ymd: string, n: number) => fmtYmd(addDays(parseYmd(ymd), n));
const weekdayOf = (ymd: string) => parseYmd(ymd).getUTCDay() as Weekday;

/** A malformed stored ordinal must not stop the page opening. */
function tolerantOrdinals(stored: string[] | null): Ordinal[] {
	try {
		const out = (stored ?? []).map(parseOrdinal);
		return out.length > 0 ? out : FALLBACK_ORDINALS;
	} catch {
		return FALLBACK_ORDINALS;
	}
}

export function meetingFormDefaults(input: {
	rule: StoredRecurrenceRule | null;
	/** "YYYY-MM-DDTHH:mm", club tz, latest meeting of ANY status. */
	latestMeetingWall: string | null;
	clubDefaultLocation: string | null;
	/** YYYY-MM-DD, club tz. */
	today: string;
	/** HH:mm now, club tz. When given, a start that would land on today at a
	 *  time already past moves to the next occurrence instead. */
	nowTime?: string;
}): MeetingFormDefaults {
	const { rule, latestMeetingWall, clubDefaultLocation, today, nowTime } =
		input;
	const latestDate = latestMeetingWall?.slice(0, 10) ?? null;
	const latestTime = latestMeetingWall?.slice(11, 16) ?? null;

	const weekday: Weekday = rule
		? (rule.weekday as Weekday)
		: latestDate !== null
			? weekdayOf(latestDate)
			: FALLBACK_WEEKDAY;
	const timeOfDay = rule?.timeOfDay ?? latestTime ?? FALLBACK_TIME;

	// The first date on/after `notBefore`: the rule's own occurrence (keeping an
	// every-N-weeks rule on its phase), else the weekday. Never throws.
	function firstDateFrom(notBefore: string): string {
		if (rule) {
			try {
				const { occurrences } = generateOccurrences(
					buildTopUpRecurrenceInput(rule, notBefore),
				);
				if (occurrences[0]) return occurrences[0].date;
			} catch {
				// malformed row: fall through to the weekday computation
			}
		}
		return shiftYmd(notBefore, (weekday - weekdayOf(notBefore) + 7) % 7);
	}

	let startDate: string;
	if (!rule && latestDate === null) {
		startDate = today;
	} else {
		// The day after the latest meeting, or today when it is behind us.
		const notBefore =
			latestDate !== null && latestDate >= today
				? shiftYmd(latestDate, 1)
				: today;
		startDate = firstDateFrom(notBefore);
		// Today, but the meeting time has already gone: take the next one.
		if (startDate === today && nowTime !== undefined && timeOfDay <= nowTime) {
			startDate = firstDateFrom(shiftYmd(today, 1));
		}
	}

	return {
		mode: rule?.mode ?? "interval",
		weekday,
		intervalWeeks: rule?.mode === "interval" ? (rule.intervalWeeks ?? 1) : 1,
		ordinals:
			rule?.mode === "monthly"
				? tolerantOrdinals(rule.ordinals)
				: FALLBACK_ORDINALS,
		timeOfDay,
		startDate,
		location: effectiveLocation(rule?.location, clubDefaultLocation) ?? "",
	};
}
