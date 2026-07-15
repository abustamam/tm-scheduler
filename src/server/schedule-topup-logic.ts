// #190 read-triggered schedule top-up. Materializes upcoming meetings from a
// club's standing recurrence rule so the calendar always holds `keep_ahead`
// future `scheduled` meetings — lazily, on authenticated schedule reads and on
// rule save (NO background poller; see docs/adr). Idempotent: re-running when
// already full is a no-op, and concurrent runs are safe via the unique
// (club_id, scheduled_at) index + ON CONFLICT DO NOTHING.
//
// DB logic lives here (not in a createServerFn module) so it's integration-
// testable and never pulled into the client bundle.
import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	roleDefinitions,
} from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { generateOccurrences } from "#/lib/meeting-recurrence";
import { buildTopUpRecurrenceInput } from "#/lib/recurrence-rule";
import { insertMeetingWithSlots } from "./meeting-create-logic";

export interface TopUpResult {
	created: number;
}

/**
 * Ensure the club's calendar holds `keep_ahead` future `scheduled` meetings,
 * generating the missing ones from the standing rule. No-op when the club has
 * no rule, the rule is disabled, or the target is already met.
 *
 * `now` is injectable for deterministic tests; defaults to the wall clock.
 */
export async function ensureScheduleToppedUp(
	clubId: string,
	now: Date = new Date(),
): Promise<TopUpResult> {
	const rule = await db.query.clubMeetingRecurrence.findFirst({
		where: eq(clubMeetingRecurrence.clubId, clubId),
	});
	if (!rule || !rule.enabled) return { created: 0 };

	const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
	if (!club) return { created: 0 };

	// Existing meetings: count FUTURE `scheduled` toward keep_ahead; every meeting
	// of ANY status occupies its local calendar date (a cancelled meeting keeps
	// its date reserved — cancellation is the skip mechanism).
	const existing = await db
		.select({
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
		})
		.from(meetings)
		.where(eq(meetings.clubId, clubId));

	const takenDates = new Set(
		existing.map((m) =>
			utcToZonedWallTime(m.scheduledAt, club.timezone).slice(0, 10),
		),
	);
	const futureScheduled = existing.filter(
		(m) => m.status === "scheduled" && m.scheduledAt.getTime() > now.getTime(),
	).length;

	const needed = rule.keepAhead - futureScheduled;
	if (needed <= 0) return { created: 0 };

	const defs = await db
		.select()
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId))
		.orderBy(asc(roleDefinitions.sortOrder));

	// Generate a window of upcoming occurrences from the rule, starting on/after
	// today's local date, then take the first `needed` that are strictly in the
	// future and not already taken.
	const notBefore = utcToZonedWallTime(now, club.timezone).slice(0, 10);
	const input = buildTopUpRecurrenceInput(rule, notBefore);
	const { occurrences } = generateOccurrences(input);

	const toCreate: Date[] = [];
	const claimed = new Set(takenDates);
	for (const occ of occurrences) {
		if (toCreate.length >= needed) break;
		if (claimed.has(occ.date)) continue; // date already occupied — skip
		const instant = zonedWallTimeToUtc(occ.wallTime, club.timezone);
		if (instant.getTime() <= now.getTime()) continue; // must be future
		claimed.add(occ.date);
		toCreate.push(instant);
	}
	if (toCreate.length === 0) return { created: 0 };

	let created = 0;
	await db.transaction(async (tx) => {
		for (const scheduledAt of toCreate) {
			const id = await insertMeetingWithSlots(
				tx,
				{
					clubId,
					scheduledAt,
					lengthMinutes: club.defaultMeetingMinutes,
					location: rule.location,
				},
				defs,
			);
			if (id) created += 1;
		}
	});

	return { created };
}
