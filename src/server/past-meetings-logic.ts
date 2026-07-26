// Past-meetings archive db logic (#375), split out from the createServerFn
// wrapper so it is directly integration-testable and never dragged into the
// client bundle (see server-modules.guard.test.ts).
//
// The mirror of `listUpcomingMeetings`: `lt(scheduledAt, before)` +
// `desc(scheduledAt)` + limit/offset, same club scoping, same open/total slot
// aggregates, same "cancelled meetings are not history you can browse" rule.
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetingAttendance, meetings, roleSlots } from "#/db/schema";
import { deriveMeetingNumber } from "#/lib/meeting-number";
import { urlKeysForMeetings } from "#/lib/meeting-url";

/** Default rows per archive page. The route passes its own `limit`; this is the
 *  fallback for callers (e.g. the nav strip) that just want "a few". */
export const PAST_MEETINGS_DEFAULT_LIMIT = 25;
const PAST_MEETINGS_MAX_LIMIT = 100;

export interface PastMeetingRow {
	id: string;
	scheduledAt: Date;
	theme: string | null;
	location: string | null;
	/** Never "cancelled" — cancelled meetings are excluded (see below). */
	status: "scheduled" | "completed";
	openSlots: number;
	totalSlots: number;
	/** Canonical club-local-date key for `/club/:clubId/meeting/:key`. Computed
	 *  across the club's WHOLE history, not just this page, so a double-header
	 *  keeps its `-HHmm` suffix even when only one of the pair is on the page. */
	urlKey: string;
	/** The number to DISPLAY (#358): stored when frozen, else derived. Null when
	 *  the club has never numbered a meeting. */
	meetingNumber: number | null;
	/** True once minutes have actually been recorded (any saved attendance row).
	 *  There is no "minutes sent" record anywhere in the schema — see the note in
	 *  `listPastMeetings`. */
	hasMinutes: boolean;
}

export interface PastMeetingsPage {
	meetings: PastMeetingRow[];
	/** A further page exists after this one (fetched limit+1 to find out). */
	hasMore: boolean;
	timezone: string;
	/** The club's URL slug — rows link to `/club/<slug>/meeting/<urlKey>`. */
	clubSlug: string | null;
}

/**
 * A page of the club's past meetings, newest first.
 *
 * CANCELLED MEETINGS ARE EXCLUDED. Beyond matching every other derivation in
 * the app, the decisive reason is that a cancelled meeting has no reachable
 * page: `resolveMeetingKey` skips cancelled rows when resolving a bare-date key,
 * so a cancelled row's canonical URL would either 404 or silently land on a
 * DIFFERENT meeting held that same day. It also carries no meeting number
 * (`deriveMeetingNumber` returns null for a cancelled target). Listing one would
 * be a broken link that reads like a meeting that happened.
 *
 * `before` defaults to now (the archive). The meeting page passes the viewed
 * meeting's own instant so the nav strip pages backwards from THERE rather than
 * from today.
 */
export async function loadPastMeetings(input: {
	clubId: string;
	before?: Date;
	limit?: number;
	offset?: number;
}): Promise<PastMeetingsPage> {
	const before = input.before ?? new Date();
	const limit = Math.min(
		Math.max(input.limit ?? PAST_MEETINGS_DEFAULT_LIMIT, 1),
		PAST_MEETINGS_MAX_LIMIT,
	);
	const offset = Math.max(input.offset ?? 0, 0);

	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
		columns: { timezone: true, slug: true },
	});
	const timezone = club?.timezone ?? "UTC";

	// One row over the limit tells us whether a further page exists without a
	// second count query.
	const rows = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
			location: meetings.location,
			status: meetings.status,
			openSlots: sql<number>`count(*) filter (where ${roleSlots.status} = 'open')::int`,
			totalSlots: sql<number>`count(${roleSlots.id})::int`,
		})
		.from(meetings)
		.leftJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				lt(meetings.scheduledAt, before),
				ne(meetings.status, "cancelled"),
			),
		)
		.groupBy(meetings.id)
		.orderBy(desc(meetings.scheduledAt))
		.limit(limit + 1)
		.offset(offset);

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	if (page.length === 0) {
		return {
			meetings: [],
			hasMore: false,
			timezone,
			clubSlug: club?.slug ?? null,
		};
	}

	// The club's full meeting spine, ordered — one query that serves BOTH the
	// per-row number and the url keys, instead of `resolveMeetingKey` /
	// `resolveMeetingNumber` per row (the N+1 trap). Cancelled rows stay in for
	// numbering (an anchor could be one); they are filtered out for url keys, to
	// match `resolveMeetingKey`'s own same-day collision rule.
	const spine = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.clubId, input.clubId))
		.orderBy(asc(meetings.scheduledAt));
	const keys = urlKeysForMeetings(
		spine.filter((m) => m.status !== "cancelled"),
		timezone,
	);

	// Which of these meetings actually have minutes recorded — one grouped query
	// over the page's ids.
	const minutesRows = await db
		.select({ meetingId: meetingAttendance.meetingId })
		.from(meetingAttendance)
		.where(
			inArray(
				meetingAttendance.meetingId,
				page.map((m) => m.id),
			),
		)
		.groupBy(meetingAttendance.meetingId);
	const withMinutes = new Set(minutesRows.map((r) => r.meetingId));

	return {
		meetings: page.map((m) => ({
			id: m.id,
			scheduledAt: m.scheduledAt,
			theme: m.theme,
			location: m.location,
			// The `ne(status, 'cancelled')` filter above narrows this at runtime;
			// the enum type still includes it.
			status: m.status as "scheduled" | "completed",
			openSlots: m.openSlots,
			totalSlots: m.totalSlots,
			urlKey: keys.get(m.id) ?? m.id,
			meetingNumber: deriveMeetingNumber(spine, m.id),
			hasMinutes: withMinutes.has(m.id),
		})),
		hasMore,
		timezone,
		clubSlug: club?.slug ?? null,
	};
}
