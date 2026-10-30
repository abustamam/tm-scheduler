// Counts behind the member milestones (#1425). Lives in a `*-logic.ts` so it is
// integration-testable and never reaches the client bundle.
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	meetingAttendance,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import type { MilestoneCounts } from "#/lib/milestones";

/**
 * One roster member's own numbers, never anyone else's.
 *
 * `speechesDelivered`: speaker slots THIS member holds, with a speech attached,
 * on a meeting that is not cancelled and whose end (`scheduled_at +
 * length_minutes`) is already past. A guest's slot has no `assigned_member_id`
 * so it never matches.
 * `meetingsAttended`: this member's `present` attendance rows.
 */
export async function loadMilestoneCounts(
	memberId: string,
): Promise<MilestoneCounts> {
	const [speechRow] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				eq(roleDefinitions.isSpeakerRole, true),
				sql`${roleSlots.speechId} is not null`,
				ne(meetings.status, "cancelled"),
				sql`${meetings.scheduledAt} + ${meetings.lengthMinutes} * interval '1 minute' < now()`,
			),
		);
	const [attendRow] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(meetingAttendance)
		.where(
			and(
				eq(meetingAttendance.memberId, memberId),
				eq(meetingAttendance.status, "present"),
			),
		);
	return {
		speechesDelivered: speechRow?.n ?? 0,
		meetingsAttended: attendRow?.n ?? 0,
	};
}
