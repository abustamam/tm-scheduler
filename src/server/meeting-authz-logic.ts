// Authorization decision for per-meeting agenda writes, split out from the
// session-aware guard in `guards.ts` so the db-touching branch logic is
// directly integration-testable by mocking `#/db`. This module must never be
// imported by client components (it touches `db`/`pg`).
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMemberships,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { isTmodRoleName } from "#/lib/meeting-roles";

export interface MeetingAgendaAuthzInput {
	meetingId: string;
	/** Signed-in user id (admin/vpe path), or null for public callers. */
	sessionUserId?: string | null;
	/** Self-asserted roster member id (TMOD path), or null. */
	selfMemberId?: string | null;
}

export interface MeetingAgendaAuthz {
	clubId: string;
	allowed: boolean;
	/** Which path granted access (null when denied). Callers use this to keep
	 *  reschedule/cancel/status admin-only: a `tmod-self-assert` grant must not
	 *  ride the club-decision boundary. */
	via: "admin-vpe" | "tmod-self-assert" | null;
	/** The meeting's TMOD slot assignee, or null when unassigned/absent. */
	tmodMemberId: string | null;
}

/**
 * Decide whether a caller may edit a meeting's agenda content (meta + slots).
 * Allowed when the caller is a club `admin`/`vpe` (via a live session) OR the
 * self-asserted `memberId` equals the meeting's TMOD slot assignee. If the TMOD
 * slot is unassigned there is no self-serve editor — only admin/vpe pass.
 * Throws when the meeting does not exist.
 */
export async function resolveMeetingAgendaAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<MeetingAgendaAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const clubId = meeting.clubId;

	// Resolve the meeting's TMOD slot assignee (if any). Match the role by name
	// the same way the rest of the app identifies the Toastmaster role.
	const slotRows = await db
		.select({
			name: roleDefinitions.name,
			assignedMemberId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.meetingId, input.meetingId));
	const tmodSlot = slotRows.find((r) => isTmodRoleName(r.name));
	const tmodMemberId = tmodSlot?.assignedMemberId ?? null;

	// Admin/vpe path: a live session whose membership is active admin/vpe.
	if (input.sessionUserId) {
		const [membership] = await db
			.select({
				clubRole: clubMemberships.clubRole,
				status: clubMemberships.status,
			})
			.from(clubMemberships)
			.where(
				and(
					eq(clubMemberships.userId, input.sessionUserId),
					eq(clubMemberships.clubId, clubId),
				),
			)
			.limit(1);
		if (
			membership &&
			membership.status === "active" &&
			(membership.clubRole === "admin" || membership.clubRole === "vpe")
		) {
			return { clubId, allowed: true, via: "admin-vpe", tmodMemberId };
		}
	}

	// TMOD self-assert path: caller holds this meeting's TMOD slot.
	if (
		input.selfMemberId &&
		tmodMemberId &&
		input.selfMemberId === tmodMemberId
	) {
		return { clubId, allowed: true, via: "tmod-self-assert", tmodMemberId };
	}

	return { clubId, allowed: false, via: null, tmodMemberId };
}
