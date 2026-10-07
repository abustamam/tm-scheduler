/**
 * What the meeting forms open on (#1086): the club's standing schedule, then
 * its latest meeting, then fixed fallbacks, decided PER FIELD. Pure and
 * db-free; `today` is injected so a test never reads the clock.
 */

import {
	generateOccurrences,
	type Ordinal,
	type Weekday,
} from "./meeting-recurrence";
import {
	buildTopUpRecurrenceInput,
	type StoredRecurrenceRule,
} from "./recurrence-rule";

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

function ymdToDate(ymd: string): Date {
	const [y, m, d] = ymd.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function dateToYmd(dt: Date): string {
	return dt.toISOString().slice(0, 10);
}

function addDays(ymd: string, n: number): string {
	return dateToYmd(new Date(ymdToDate(ymd).getTime() + n * 86_400_000));
}

function weekdayOf(ymd: string): Weekday {
	return ymdToDate(ymd).getUTCDay() as Weekday;
}

function parseOrdinals(stored: string[] | null): Ordinal[] {
	const out: Ordinal[] = [];
	for (const s of stored ?? []) {
		if (s === "last") out.push("last");
		else {
			const n = Number(s);
			if (n >= 1 && n <= 5) out.push(n as Ordinal);
		}
	}
	return out.length > 0 ? out : FALLBACK_ORDINALS;
}

export function meetingFormDefaults(input: {
	rule: StoredRecurrenceRule | null;
	/** "YYYY-MM-DDTHH:mm", club tz, latest meeting of ANY status. */
	latestMeetingWall: string | null;
	clubDefaultLocation: string | null;
	/** YYYY-MM-DD, club tz. */
	today: string;
}): MeetingFormDefaults {
	const { rule, latestMeetingWall, clubDefaultLocation, today } = input;
	const latestDate = latestMeetingWall?.slice(0, 10) ?? null;
	const latestTime = latestMeetingWall?.slice(11, 16) ?? null;

	// The day after the latest meeting, or today when it is behind us.
	const notBefore =
		latestDate !== null && latestDate >= today ? addDays(latestDate, 1) : today;

	const weekday: Weekday = rule
		? (rule.weekday as Weekday)
		: latestDate !== null
			? weekdayOf(latestDate)
			: FALLBACK_WEEKDAY;

	let startDate: string | null = null;
	if (rule) {
		try {
			const { occurrences } = generateOccurrences(
				buildTopUpRecurrenceInput(rule, notBefore),
			);
			startDate = occurrences[0]?.date ?? null;
		} catch {
			startDate = null; // malformed row: the page must still open
		}
	}
	if (startDate === null) {
		if (latestDate === null) startDate = today;
		else {
			startDate = addDays(notBefore, (weekday - weekdayOf(notBefore) + 7) % 7);
		}
	}

	return {
		mode: rule?.mode ?? "interval",
		weekday,
		intervalWeeks: rule?.mode === "interval" ? (rule.intervalWeeks ?? 1) : 1,
		ordinals:
			rule?.mode === "monthly"
				? parseOrdinals(rule.ordinals)
				: FALLBACK_ORDINALS,
		timeOfDay: rule?.timeOfDay ?? latestTime ?? FALLBACK_TIME,
		startDate,
		location: rule?.location ?? clubDefaultLocation ?? "",
	};
}
