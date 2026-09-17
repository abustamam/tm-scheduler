/**
 * `list_meetings` — a club's calendar, in the club's own timezone (#773).
 *
 * Dates in and out are club-local `YYYY-MM-DD`. A token caller has no locale and
 * no browser, so every instant would otherwise be read as UTC and a 7pm Tuesday
 * meeting would list as Wednesday for half the year.
 *
 * **The top-up runs here, once, before anything else** (design D6/T4).
 * `ensureScheduleToppedUp` materialises the club's standing recurrence rule into
 * real rows, and it is triggered by authenticated READS (ADR-0021) — which token
 * calls are not. Without this call the tools would see a calendar the browser
 * does not: a club that keeps four meetings ahead would show however many
 * happened to exist when a human last opened the schedule. It is called outside
 * any transaction, deliberately: `ensureScheduleToppedUp` imports `db` directly
 * and takes no connection, so calling it inside one would write on a second
 * connection while a lock is held.
 */
import { and, asc, count, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { deriveMeetingNumber } from "#/lib/meeting-number";
import { ensureScheduleToppedUp } from "#/server/schedule-topup-logic";
import { authorizeToken } from "../authz-logic";
import type { McpToolDefinition } from "../tool";

/** A club-local calendar date. The only date shape these tools speak. */
export const localDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use a club-local date, YYYY-MM-DD.");

const inputSchema = {
	clubId: z.string().uuid(),
	from: localDate.optional().describe("Club-local date, inclusive."),
	to: localDate.optional().describe("Club-local date, inclusive."),
};

const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

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

/** The club-local `YYYY-MM-DD` and `HH:mm` of an instant, plus its weekday. */
export function clubLocalParts(instant: Date, timezone: string) {
	const wall = utcToZonedWallTime(instant, timezone);
	const date = wall.slice(0, 10);
	// Read the weekday off the club-local DATE, not off the instant: `new
	// Date("2026-09-16")` is parsed as UTC midnight, which is the same calendar
	// day everywhere, so `getUTCDay` on it is the club-local weekday.
	const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
	return { date, time: wall.slice(11, 16), weekday };
}

export const listMeetingsTool: McpToolDefinition = {
	name: "list_meetings",
	config: {
		title: "List meetings",
		description:
			"A club's meetings between two club-local dates (default: the next " +
			"three months). Returns each meeting's id, club-local date and time, " +
			"meeting number, theme, status and how many role slots are still open.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeToken(ctx.rawToken, args.clubId);

		// Before planning, before reading, outside any transaction (D6).
		await ensureScheduleToppedUp(club.clubId);

		const todayLocal = utcToZonedWallTime(new Date(), club.timezone).slice(
			0,
			10,
		);
		const from = args.from ?? todayLocal;
		// Three months is the window a season's worth of planning needs without
		// returning a club's whole history into a transcript.
		const to = args.to ?? addMonthsToLocalDate(from, 3);

		// Club-local day bounds → instants. `to` is inclusive, so the upper bound
		// is the start of the NEXT day.
		const fromInstant = zonedWallTimeToUtc(`${from}T00:00`, club.timezone);
		const toInstant = zonedWallTimeToUtc(`${to}T23:59`, club.timezone);

		// The whole spine in one query, so the per-row meeting number is not an
		// N+1 of `resolveMeetingNumber` (the trap `past-meetings-logic` names).
		// Cancelled rows stay in: one could be a numbering anchor.
		const spine = await db
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				status: meetings.status,
				meetingNumber: meetings.meetingNumber,
			})
			.from(meetings)
			.where(eq(meetings.clubId, club.clubId))
			.orderBy(asc(meetings.scheduledAt));

		const rows = await db
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				status: meetings.status,
				theme: meetings.theme,
				openSlots: sql<number>`count(*) filter (where ${roleSlots.status} = 'open')`,
				totalSlots: count(roleSlots.id),
			})
			.from(meetings)
			.leftJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
			.where(
				and(
					eq(meetings.clubId, club.clubId),
					gte(meetings.scheduledAt, fromInstant),
					lte(meetings.scheduledAt, toInstant),
				),
			)
			.groupBy(meetings.id)
			.orderBy(asc(meetings.scheduledAt));

		return {
			clubId: club.clubId,
			timezone: club.timezone,
			from,
			to,
			meetings: rows.map((m) => {
				const { date, time, weekday } = clubLocalParts(
					m.scheduledAt,
					club.timezone,
				);
				const stored = spine.find((s) => s.id === m.id)?.meetingNumber ?? null;
				return {
					meetingId: m.id,
					date,
					weekday,
					time,
					// Numbers freeze when a meeting is completed (#358); until then
					// the displayed one is derived and can still move, so say which
					// this is rather than presenting a guess as a fact.
					meetingNumber: deriveMeetingNumber(spine, m.id),
					meetingNumberProvisional: stored === null,
					theme: m.theme,
					status: m.status,
					openSlots: Number(m.openSlots ?? 0),
					totalSlots: Number(m.totalSlots ?? 0),
				};
			}),
		};
	},
};
