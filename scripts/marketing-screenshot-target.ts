/**
 * Which meeting `capture-marketing-screenshots.ts` points the print and present
 * shots at (#867, #1122). Lifted out of the script, which runs `main()` on
 * import, so the query can be tested against a database
 * (`marketing-screenshot-target.integration.test.ts`).
 *
 * Takes the Drizzle client as a parameter and imports only the schema, so it
 * opens no connection of its own: the script imports `#/db` after its Chrome
 * check, so a missing browser is reported without needing a database at all.
 */
import { and, count, eq, gte, isNotNull, ne, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "#/db/schema";
import { meetings, roleSlots } from "#/db/schema";

/** A meeting qualifies with at least this many filled role slots. */
export const MIN_ASSIGNED_SLOTS = 3;

/**
 * The earliest qualifying meeting dated today or later, else the most recent
 * qualifying past one. `candidates` holds only qualifying meetings.
 */
function pickMeeting<T extends { scheduledAt: Date }>(
	candidates: T[],
	now: Date,
): T | null {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const upcoming = candidates
		.filter((m) => m.scheduledAt >= startOfToday)
		.sort((a, b) => +a.scheduledAt - +b.scheduledAt);
	if (upcoming[0]) return upcoming[0];
	const past = candidates
		.filter((m) => m.scheduledAt < startOfToday)
		.sort((a, b) => +b.scheduledAt - +a.scheduledAt);
	return past[0] ?? null;
}

/**
 * The club's meetings with at least `MIN_ASSIGNED_SLOTS` assigned role slots.
 * A cancelled meeting never qualifies (#1084): a club that calls a night off
 * keeps the claims on it, so without the status filter the print shot lands on
 * a meeting that is not happening.
 */
export async function findQualifyingMeetings(
	db: NodePgDatabase<typeof schema>,
	clubId: string,
): Promise<{ id: string; scheduledAt: Date }[]> {
	return db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.innerJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
		.where(
			and(
				eq(meetings.clubId, clubId),
				ne(meetings.status, "cancelled"),
				or(
					isNotNull(roleSlots.assignedMemberId),
					isNotNull(roleSlots.assignedGuestId),
				),
			),
		)
		.groupBy(meetings.id, meetings.scheduledAt)
		.having(gte(count(roleSlots.id), MIN_ASSIGNED_SLOTS));
}

/** The meeting to capture, or null when the club has none that qualifies. */
export async function findCaptureMeeting(
	db: NodePgDatabase<typeof schema>,
	clubId: string,
): Promise<{ id: string; scheduledAt: Date } | null> {
	return pickMeeting(await findQualifyingMeetings(db, clubId), new Date());
}
