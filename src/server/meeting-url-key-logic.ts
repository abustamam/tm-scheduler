// src/server/meeting-url-key-logic.ts
//
// ONE resolver for a meeting's canonical URL key (date-urls feature): the
// club-local date, suffixed with -HHmm only when the club has two or more
// meetings that local day, CANCELLED ONES INCLUDED (#1396): a cancelled meeting
// that shares its date with a live one must not get the bare date, which
// resolves to the live one. A bare date resolves to the EARLIEST
// meeting that day, so a double-header's later meeting needs the suffix or its
// links open the wrong meeting.
//
// Extracted when #932 needed the NEXT meeting's key for the deck's sign-up QR:
// `loadMeetingDetail` computed the current meeting's key inline, and a second
// copy of the same-day count would be two answers to "which key names this
// meeting" that could drift apart — the QR opening a different meeting than
// the page's own canonical link.
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	localDateKey,
	localDayRange,
	meetingUrlKey,
	urlKeysForMeetings,
} from "#/lib/meeting-url";

export async function resolveMeetingUrlKey(
	clubId: string,
	scheduledAt: Date,
	timezone: string,
): Promise<string> {
	const { start, end } = localDayRange(
		localDateKey(scheduledAt, timezone),
		timezone,
	);
	const [{ count } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, start),
				lt(meetings.scheduledAt, end),
			),
		);
	return meetingUrlKey(scheduledAt, timezone, count >= 2);
}

/**
 * {@link resolveMeetingUrlKey} for a list: id → canonical key, in one query.
 * Collisions are counted over EVERY meeting the club has on each item's local
 * date, so a list that hides cancelled meetings still names a meeting the way
 * its own page does (#1396). Use this, not a bare `urlKeysForMeetings`, for any
 * list that is not the club's whole spine.
 */
export async function urlKeysForClubMeetings(
	clubId: string,
	items: { id: string; scheduledAt: Date | string }[],
	timezone: string,
): Promise<Map<string, string>> {
	if (items.length === 0) return new Map();
	const dates = items.map((i) =>
		localDateKey(new Date(i.scheduledAt), timezone),
	);
	const first = dates.reduce((a, b) => (a < b ? a : b));
	const last = dates.reduce((a, b) => (a > b ? a : b));
	const rows = await db
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, localDayRange(first, timezone).start),
				lt(meetings.scheduledAt, localDayRange(last, timezone).end),
			),
		);
	return urlKeysForMeetings(
		items,
		timezone,
		rows.map((r) => r.scheduledAt),
	);
}
