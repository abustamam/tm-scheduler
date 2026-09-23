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
import {
	addMonthsToLocalDate,
	clubLocalParts,
	localDate,
} from "#/lib/club-local-date";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { deriveMeetingNumber } from "#/lib/meeting-number";
import { ensureScheduleToppedUp } from "#/server/schedule-topup-logic";
import { authorizeToken } from "../authz-logic";
import type { McpToolDefinition } from "../tool";

// `get_agenda` reads `clubLocalParts` through this module. Re-exported rather
// than repointed because `get-agenda.ts` is outside #776's declared change set;
// the helper itself now lives in `#/lib/club-local-date` with the other three.
export { clubLocalParts };

const inputSchema = {
	clubId: z.string().uuid(),
	from: localDate.optional().describe("Club-local date, inclusive."),
	to: localDate.optional().describe("Club-local date, inclusive."),
};

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
		const { club } = await authorizeToken(ctx, args.clubId);

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
