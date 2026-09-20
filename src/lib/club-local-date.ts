/**
 * The club-local calendar date — the only date shape the MCP tools speak
 * (#773, #776 item 5).
 *
 * A token caller has no locale and no browser, so every instant would otherwise
 * be read as UTC and a 7pm Tuesday meeting would list as Wednesday for half the
 * year. Every date in and out of those tools is therefore a club-local
 * `YYYY-MM-DD`, and these four helpers are how one is parsed, moved and derived.
 *
 * They were written in two different tool modules, which imported each other
 * sideways to share them, and one of them had grown two near-identical copies
 * of the same calendar-arithmetic shape (`addMonthsToLocalDate` in
 * `list-meetings.ts`, `nextLocalDate` in `record-guest-book.ts`). Every one is
 * pure and db-free, so they belong in `lib/`, where a test can import them
 * without a database and where a third tool needing a date does not reach into
 * a second tool's module to get one.
 *
 * **Calendar arithmetic, not instant arithmetic.** `addMonths` and `addDays`
 * build the UTC-midnight instant of the date and step THAT, so no timezone is
 * involved and no DST boundary can shorten or lengthen the step. A club-local
 * day is 23 or 25 hours long twice a year; "the next date on the calendar" is
 * always exactly one date later regardless.
 */
import { z } from "zod";
import { utcToZonedWallTime } from "./datetime";

/** A club-local calendar date. The only date shape the MCP tools speak. */
export const localDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use a club-local date, YYYY-MM-DD.");

const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

/** The name of a weekday, as these tools report it. */
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * `YYYY-MM-DD` plus N months, as a calendar date — no timezone involved.
 *
 * Built from the UTC-midnight instant of the date so `setUTCMonth` does the
 * month-end clamping (31 Jan + 1 month → 3 Mar, JavaScript's own rule). Only
 * used for the default upper bound of a search window, where landing a day or
 * two either side of "three months out" changes nothing.
 */
export function addMonthsToLocalDate(date: string, months: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` + 1 day, as a calendar date.
 *
 * What turns "the club-local day the caller named" into a half-open instant
 * range: both bounds are converted from club-local midnights rather than
 * derived by adding 24h to the first, because across a DST boundary the local
 * day is not 24 hours long.
 */
export function nextLocalDate(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/**
 * The weekday INDEX of a club-local `YYYY-MM-DD` — 0 = Sunday, matching
 * `Date.getUTCDay()`, `RecurrenceInput.Weekday` and
 * `club_meeting_recurrence.weekday`.
 *
 * Numeric as well as named because the two readers want different things:
 * `upsert_agendas` compares a proposed date against the club's stored rule,
 * which is an integer, while a plan line renders a name. Deriving one from the
 * other at each call site is how the two spellings drift.
 *
 * Read off the DATE, not off an instant: `new Date("2026-09-16")` is parsed as
 * UTC midnight, which is the same calendar day everywhere, so `getUTCDay` on it
 * is the club-local weekday.
 */
export function localDateWeekdayIndex(date: string): number {
	return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The weekday NAME of a club-local `YYYY-MM-DD`. */
export function localDateWeekday(date: string): Weekday {
	return WEEKDAYS[localDateWeekdayIndex(date)] as Weekday;
}

/** The club-local `YYYY-MM-DD` and `HH:mm` of an instant, plus its weekday. */
export function clubLocalParts(
	instant: Date,
	timezone: string,
): { date: string; time: string; weekday: Weekday } {
	const wall = utcToZonedWallTime(instant, timezone);
	const date = wall.slice(0, 10);
	return { date, time: wall.slice(11, 16), weekday: localDateWeekday(date) };
}
