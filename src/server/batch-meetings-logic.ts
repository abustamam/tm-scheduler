// Batch meeting-create DB logic, split out from the `batch-meetings.ts`
// createServerFn wrappers (the server-modules guard forbids db-touching exports
// there). Directly integration-testable by mocking `#/db`.
//
// This mirrors `applyCreateMeeting` (fetch club, zonedWallTimeToUtc, insert with
// the club's defaultMeetingMinutes + generated role slots) but for many dates in
// ONE transaction, fetching the club's role definitions ONCE and reusing them.
// No activity-log entry — single-create doesn't log creation, so batch keeps
// parity.
import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, roleDefinitions } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { insertMeetingWithSlots } from "./meeting-create-logic";

export interface BatchCreateInput {
	clubId: string;
	/**
	 * Wall-clock datetime-local strings (`YYYY-MM-DDTHH:mm`) in the club
	 * timezone — already generated + pruned of removed rows by the caller.
	 */
	wallTimes: string[];
	location?: string | null;
}

export interface BatchCreateResult {
	createdCount: number;
	/** Local calendar dates (YYYY-MM-DD) skipped because one already existed. */
	skippedDates: string[];
}

/** The local calendar date (YYYY-MM-DD, club tz) of a wall-clock string. */
function localDate(wall: string): string {
	return wall.slice(0, 10);
}

/**
 * Create every non-duplicate meeting for the batch in ONE all-or-nothing
 * transaction, each with role slots from the club's template. A generated date
 * that already has a meeting on the SAME calendar date (club tz) is skipped —
 * so re-running an identical batch creates nothing new.
 */
export async function applyBatchCreateMeetings(
	input: BatchCreateInput,
): Promise<BatchCreateResult> {
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
	});
	if (!club) throw new Error("Club not found.");

	// Fetch the role template ONCE and reuse it across every meeting in the batch.
	const defs = await db
		.select()
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, input.clubId))
		.orderBy(asc(roleDefinitions.sortOrder));

	// Existing meetings' local dates (any status) occupy their calendar date.
	const existing = await db
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(eq(meetings.clubId, input.clubId));
	const takenDates = new Set(
		existing.map((m) =>
			utcToZonedWallTime(m.scheduledAt, club.timezone).slice(0, 10),
		),
	);

	// De-dupe within the batch too, and skip any date already taken.
	const location = input.location?.trim() || null;
	const skippedDates: string[] = [];
	const toCreate: { scheduledAt: Date }[] = [];
	const seen = new Set<string>();
	for (const wall of input.wallTimes) {
		const date = localDate(wall);
		if (seen.has(date)) continue; // duplicate within the submitted batch
		seen.add(date);
		if (takenDates.has(date)) {
			skippedDates.push(date);
			continue;
		}
		toCreate.push({ scheduledAt: zonedWallTimeToUtc(wall, club.timezone) });
	}

	if (toCreate.length === 0) {
		return { createdCount: 0, skippedDates };
	}

	let createdCount = 0;
	await db.transaction(async (tx) => {
		for (const { scheduledAt } of toCreate) {
			const id = await insertMeetingWithSlots(
				tx,
				{
					clubId: input.clubId,
					scheduledAt,
					lengthMinutes: club.defaultMeetingMinutes,
					location,
				},
				defs,
			);
			if (id) createdCount += 1;
		}
	});

	return { createdCount, skippedDates };
}

/**
 * The local calendar dates (YYYY-MM-DD, club tz) of every existing meeting for a
 * club. Powers the batch preview's "already scheduled — will skip" greying so
 * the client marks duplicates before committing (the server re-checks on write).
 */
export async function listClubMeetingDates(clubId: string): Promise<string[]> {
	const club = await db.query.clubs.findFirst({ where: eq(clubs.id, clubId) });
	if (!club) throw new Error("Club not found.");
	const rows = await db
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(eq(meetings.clubId, clubId));
	return [
		...new Set(
			rows.map((m) =>
				utcToZonedWallTime(m.scheduledAt, club.timezone).slice(0, 10),
			),
		),
	];
}
