import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { localDayRange, parseMeetingKey } from "#/lib/meeting-url";

/**
 * Resolve a `$meetingId` URL segment (club-local date / date-HHmm / uuid) to a
 * meeting id, scoped to `clubId`. Returns null when nothing matches — including a
 * uuid that belongs to a different club (so callers get not-found, not a leak).
 * A bare-date double-header resolves to the earliest meeting that local day.
 */
export async function resolveMeetingKey(
	clubId: string,
	key: string,
): Promise<string | null> {
	const parsed = parseMeetingKey(key);
	if (parsed.kind === "invalid") return null;

	if (parsed.kind === "uuid") {
		const row = await db.query.meetings.findFirst({
			where: and(eq(meetings.id, parsed.id), eq(meetings.clubId, clubId)),
			columns: { id: true },
		});
		return row?.id ?? null;
	}

	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, clubId),
		columns: { timezone: true },
	});
	const tz = club?.timezone ?? "UTC";

	if (parsed.kind === "instant") {
		const at = zonedWallTimeToUtc(
			`${parsed.date}T${parsed.hh}:${parsed.mm}`,
			tz,
		);
		const row = await db.query.meetings.findFirst({
			where: and(eq(meetings.clubId, clubId), eq(meetings.scheduledAt, at)),
			columns: { id: true },
		});
		return row?.id ?? null;
	}

	// date kind → earliest meeting within the club-local day.
	const { start, end } = localDayRange(parsed.date, tz);
	const [row] = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, start),
				lt(meetings.scheduledAt, end),
			),
		)
		.orderBy(asc(meetings.scheduledAt))
		.limit(1);
	return row?.id ?? null;
}
