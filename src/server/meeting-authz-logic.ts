// Authorization decision for per-meeting agenda writes, split out from the
// session-aware guard in `guards.ts` so the db-touching branch logic is
// directly integration-testable by mocking `#/db`. This module must never be
// imported by client components (it touches `db`/`pg`).
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import { isTmodRoleName } from "#/lib/meeting-roles";
import { markImpersonatedWrite } from "./impersonation-actor";
import { getActiveImpersonation } from "./impersonation-logic";

/**
 * The meeting-lock choke point (#150). Throws when a meeting's status is
 * `completed` so every agenda mutation that runs it inherits the lock. Only
 * "Reopen" (a separate admin path) may change a completed meeting. Pure — call
 * with the status a mutation already loaded.
 */
export function assertMeetingNotLocked(status: string): void {
	if (isMeetingLocked(status)) {
		throw new Error(MEETING_LOCKED_MESSAGE);
	}
}

export interface MeetingAgendaAuthzInput {
	meetingId: string;
	/** Signed-in user id (admin path), or null for public callers. */
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
	via: "admin" | "tmod-self-assert" | null;
	/** The meeting's TMOD slot assignee, or null when unassigned/absent. */
	tmodMemberId: string | null;
}

/**
 * Decide whether a caller may edit a meeting's agenda content (meta + slots).
 * Allowed when the caller is a club `admin` (via a live session) OR the
 * self-asserted `memberId` equals the meeting's TMOD slot assignee. If the TMOD
 * slot is unassigned there is no self-serve editor — only admin passes.
 * Throws when the meeting does not exist.
 */
export async function resolveMeetingAgendaAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<MeetingAgendaAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	// Lock choke point (#150): a completed meeting rejects every agenda edit that
	// funnels through here (update meta, add/remove/move speaker). Reopen is a
	// separate admin path and does not run this.
	assertMeetingNotLocked(meeting.status);
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

	// Admin path: a live session that resolves (via Person) to an active admin
	// membership in this club (ADR-0008 Phase B).
	if (input.sessionUserId) {
		const [membership] = await db
			.select({
				clubRole: members.clubRole,
				status: members.status,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(
				and(eq(people.userId, input.sessionUserId), eq(members.clubId, clubId)),
			)
			.limit(1);
		if (
			membership &&
			membership.status === "active" &&
			membership.clubRole === "admin"
		) {
			return { clubId, allowed: true, via: "admin", tmodMemberId };
		}

		// Read-write impersonation (#246): a superadmin acting as this club's admin
		// gets the admin editor path. Mark the request so the agenda write is
		// attributed to the real superadmin. (A read_only session never reaches here
		// — writes stay blind to it by construction.)
		const session = await getActiveImpersonation(input.sessionUserId, clubId);
		if (session?.mode === "read_write") {
			markImpersonatedWrite(input.sessionUserId);
			return { clubId, allowed: true, via: "admin", tmodMemberId };
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
