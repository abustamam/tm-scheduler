// Meeting-number db logic (#358), split out from the createServerFn wrappers so
// it is directly integration-testable and never dragged into the client bundle.
// The numbering RULES are pure and live in `#/lib/meeting-number`; this module
// only feeds them rows and writes the frozen result back.
import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	deriveMeetingNumber,
	type MeetingNumberRow,
} from "#/lib/meeting-number";

/**
 * The club's meetings up to and including `scheduledAt`, in chronological order
 * — everything `deriveMeetingNumber` needs and nothing more. Bounded by the
 * target's own instant because derivation only ever looks BACKWARDS to the
 * nearest anchor; served by the existing (club_id, scheduled_at) unique index.
 */
async function rowsThrough(
	clubId: string,
	scheduledAt: Date,
): Promise<MeetingNumberRow[]> {
	return db
		.select({
			id: meetings.id,
			status: meetings.status,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(
			and(eq(meetings.clubId, clubId), lte(meetings.scheduledAt, scheduledAt)),
		)
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
			scheduledAt: meetings.scheduledAt,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) return null;
	if (meeting.meetingNumber != null) return meeting.meetingNumber;

	const rows = await rowsThrough(meeting.clubId, meeting.scheduledAt);
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
			scheduledAt: meetings.scheduledAt,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting || meeting.meetingNumber != null) return;

	const rows = await rowsThrough(meeting.clubId, meeting.scheduledAt);
	const derived = deriveMeetingNumber(rows, meetingId);
	if (derived == null) return;

	await db
		.update(meetings)
		.set({ meetingNumber: derived })
		.where(eq(meetings.id, meetingId));
}
