// "Welcome back" (#1446): when an officer marks a slipping or lapsed member
// Present, the roll toasts how long it has been. Nothing is stored; the answer
// is derived from the same rules the lapse list uses.
import { and, eq, inArray } from "drizzle-orm";
import type { db } from "#/db";
import { meetingAttendance, meetings, members, roleSlots } from "#/db/schema";
import { ATTENDANCE_LAPSE, scoreAttendanceLapse } from "#/lib/attendance-lapse";
import {
	HELD_SLOT_STATUSES,
	selectLapseEligibleMeetings,
} from "./reporting-logic";

export interface WelcomeBack {
	/** The last meeting the member was present at (or held a role at), or null
	 *  when they never were since joining. */
	lastPresentAt: Date | null;
}

/**
 * Null unless the member's miss streak BEFORE this meeting is at or past
 * `slippingThreshold`. Only meetings strictly before this one count, so the
 * Present write that triggers the question never answers it. Eligibility is
 * `selectLapseEligibleMeetings`, the lapse list's own rule (past, not
 * cancelled, somebody's roll taken); excused is transparent and a held role
 * counts as present, both via `scoreAttendanceLapse`. The history is unbounded.
 */
export async function loadWelcomeBack(
	conn: typeof db,
	input: { clubId: string; memberId: string; meetingId: string },
): Promise<WelcomeBack | null> {
	const [meeting] = await conn
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(eq(meetings.id, input.meetingId), eq(meetings.clubId, input.clubId)),
		);
	const [member] = await conn
		.select({ joinedAt: members.joinedAt, createdAt: members.createdAt })
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		);
	if (!meeting || !member) return null;

	const window = await selectLapseEligibleMeetings(conn, {
		clubId: input.clubId,
		before: meeting.scheduledAt,
	});
	const ids = window.map((m) => m.meetingId);

	const [markRows, roleRows] = await Promise.all([
		conn
			.select({
				meetingId: meetingAttendance.meetingId,
				status: meetingAttendance.status,
			})
			.from(meetingAttendance)
			.where(
				and(
					inArray(meetingAttendance.meetingId, ids),
					eq(meetingAttendance.memberId, input.memberId),
				),
			),
		conn
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(
				and(
					inArray(roleSlots.meetingId, ids),
					eq(roleSlots.assignedMemberId, input.memberId),
					inArray(roleSlots.status, [...HELD_SLOT_STATUSES]),
				),
			),
	]);

	// An explicit row beats the role inference, as in `loadAttendanceLapse`.
	const explicit = new Set(markRows.map((r) => r.meetingId));
	const marks = [
		...markRows.map((r) => ({
			meetingId: r.meetingId,
			memberId: input.memberId,
			status: r.status,
		})),
		...roleRows
			.filter((r) => !explicit.has(r.meetingId))
			.map((r) => ({
				meetingId: r.meetingId,
				memberId: input.memberId,
				status: "present" as const,
			})),
	];

	const [row] = scoreAttendanceLapse({
		meetings: window,
		members: [
			{
				memberId: input.memberId,
				name: "",
				joinedAt: member.joinedAt ?? member.createdAt,
			},
		],
		marks,
	});
	if (!row || row.streak < ATTENDANCE_LAPSE.slippingThreshold) return null;
	return { lastPresentAt: row.lastSeenAt };
}
