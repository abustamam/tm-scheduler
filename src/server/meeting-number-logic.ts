// Meeting-number db logic (#358), split out from the createServerFn wrappers so
// it is directly integration-testable and never dragged into the client bundle.
// The numbering RULES are pure and live in `#/lib/meeting-number`; this module
// only feeds them rows and writes the frozen result back.
import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	deriveMeetingNumber,
	type MeetingNumberRow,
} from "#/lib/meeting-number";

/**
 * The club's meetings in chronological order. NOT bounded by the target's date:
 * derivation looks backwards to an anchor, but a LATER stored number caps the
 * result (a back-dated meeting gets none, #1639). Served by the (club_id,
 * scheduled_at) unique index.
 */
async function clubRows(clubId: string): Promise<MeetingNumberRow[]> {
	return db
		.select({
			id: meetings.id,
			status: meetings.status,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.clubId, clubId))
		.orderBy(asc(meetings.scheduledAt));
}

/**
 * The number to DISPLAY for a meeting: its stored number when it has one, else
 * derived by counting held meetings forward from the most recent numbered one.
 * Returns null when the club has never numbered a meeting. Read-only — a
 * provisional number is never written as a side effect of rendering a page.
 */
export async function resolveMeetingNumber(
	meetingId: string,
): Promise<number | null> {
	const [meeting] = await db
		.select({
			clubId: meetings.clubId,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) return null;
	if (meeting.meetingNumber != null) return meeting.meetingNumber;

	const rows = await clubRows(meeting.clubId);
	return deriveMeetingNumber(rows, meetingId);
}

/**
 * Persist the derived number onto the row, making it permanent history and the
 * next anchor. Called when a meeting is COMPLETED. Idempotent: a meeting that
 * already carries a number is left alone, and a club with no numbering yet is a
 * no-op (we never invent a sequence).
 */
export async function freezeMeetingNumber(meetingId: string): Promise<void> {
	const [meeting] = await db
		.select({
			clubId: meetings.clubId,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting || meeting.meetingNumber != null) return;

	const rows = await clubRows(meeting.clubId);
	const derived = deriveMeetingNumber(rows, meetingId);
	if (derived == null) return;

	await db
		.update(meetings)
		.set({ meetingNumber: derived })
		.where(eq(meetings.id, meetingId));
}
