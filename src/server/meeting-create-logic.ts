// Shared per-meeting insert used by batch create (#184) and the #190 schedule
// top-up. Kept in a *-logic.ts module (no createServerFn) so it's directly
// testable and never dragged into the client bundle.
import type { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import { generateSlotRows, type SlotGenInput } from "#/lib/agenda";

type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export interface NewMeeting {
	clubId: string;
	scheduledAt: Date;
	/** Copied from the club default at insert (copy-at-insert). */
	lengthMinutes: number;
	location: string | null;
}

/**
 * Insert one meeting (plus role slots from the club template) idempotently:
 * `ON CONFLICT (club_id, scheduled_at) DO NOTHING`. Returns the new meeting id,
 * or `null` when a meeting already occupied that exact instant (or a concurrent
 * writer won the race) — the unique `(club_id, scheduled_at)` index is the
 * concurrency backstop for the read-triggered top-up. `theme`/`wordOfTheDay`/
 * `notes` are left blank; the caller passes an already-resolved `location`.
 */
export async function insertMeetingWithSlots(
	conn: DbOrTx,
	m: NewMeeting,
	defs: SlotGenInput[],
): Promise<string | null> {
	const [row] = await conn
		.insert(meetings)
		.values({
			clubId: m.clubId,
			scheduledAt: m.scheduledAt,
			lengthMinutes: m.lengthMinutes,
			location: m.location,
			theme: null,
			wordOfTheDay: null,
			notes: null,
		})
		.onConflictDoNothing()
		.returning({ id: meetings.id });
	if (!row) return null;
	const slotRows = generateSlotRows(defs, row.id);
	if (slotRows.length > 0) {
		await conn.insert(roleSlots).values(slotRows);
	}
	return row.id;
}
