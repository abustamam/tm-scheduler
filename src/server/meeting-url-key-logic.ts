// src/server/meeting-url-key-logic.ts
//
// ONE resolver for a meeting's canonical URL key (date-urls feature): the
// club-local date, suffixed with -HHmm only when the club has two or more
// non-cancelled meetings that local day. A bare date resolves to the EARLIEST
// meeting that day, so a double-header's later meeting needs the suffix or its
// links open the wrong meeting.
//
// Extracted when #932 needed the NEXT meeting's key for the deck's sign-up QR:
// `loadMeetingDetail` computed the current meeting's key inline, and a second
// copy of the same-day count would be two answers to "which key names this
// meeting" that could drift apart — the QR opening a different meeting than
// the page's own canonical link.
import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { localDateKey, localDayRange, meetingUrlKey } from "#/lib/meeting-url";

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
				ne(meetings.status, "cancelled"),
			),
		);
	return meetingUrlKey(scheduledAt, timezone, count >= 2);
}
