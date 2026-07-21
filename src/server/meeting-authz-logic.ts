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
import { isGrammarianRoleName, isTmodRoleName } from "#/lib/meeting-roles";
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
 * Admin-path grant shared by the agenda-edit and Word-of-the-Day authz: a live
 * session that resolves (via Person, ADR-0008 Phase B) to an active `admin`
 * membership in this club, OR a superadmin with an active `read_write`
 * impersonation of this club (#246). In the impersonation case it marks the
 * request so the write is attributed to the real superadmin. A `read_only`
 * session never grants — writes stay blind to it by construction. Returns true
 * when the admin path grants access.
 */
async function resolveAdminGrant(
	sessionUserId: string | null | undefined,
	clubId: string,
): Promise<boolean> {
	if (!sessionUserId) return false;
	const [membership] = await db
		.select({
			clubRole: members.clubRole,
			status: members.status,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(people.userId, sessionUserId), eq(members.clubId, clubId)))
		.limit(1);
	if (
		membership &&
		membership.status === "active" &&
		membership.clubRole === "admin"
	) {
		return true;
	}
	const session = await getActiveImpersonation(sessionUserId, clubId);
	if (session?.mode === "read_write") {
		markImpersonatedWrite(sessionUserId);
		return true;
	}
	return false;
}

/**
 * Resolve the meeting's TMOD and Grammarian slot assignees (each null when the
 * slot is unassigned or absent). Matches roles by name the same way the rest of
 * the app identifies the Toastmaster and Grammarian roles.
 */
async function loadRoleSlotAssignees(meetingId: string): Promise<{
	tmodMemberId: string | null;
	grammarianMemberId: string | null;
}> {
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
		.where(eq(roleSlots.meetingId, meetingId));
	return {
		tmodMemberId:
			slotRows.find((r) => isTmodRoleName(r.name))?.assignedMemberId ?? null,
		grammarianMemberId:
			slotRows.find((r) => isGrammarianRoleName(r.name))?.assignedMemberId ??
			null,
	};
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
	const { tmodMemberId } = await loadRoleSlotAssignees(input.meetingId);

	// Admin path (session admin or read_write impersonation, #246).
	if (await resolveAdminGrant(input.sessionUserId, clubId)) {
		return { clubId, allowed: true, via: "admin", tmodMemberId };
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

export interface WordOfTheDayAuthz {
	clubId: string;
	allowed: boolean;
	/** Which path granted access (null when denied). */
	via: "admin" | "tmod-self-assert" | "grammarian-self-assert" | null;
	tmodMemberId: string | null;
	grammarianMemberId: string | null;
}

/**
 * Decide whether a caller may edit a meeting's Word of the Day (word +
 * definition + example) — a narrower capability than the full agenda edit
 * (#296). Allowed when the caller is a club `admin` (session), OR the
 * self-asserted `memberId` holds the meeting's TMOD slot, OR the self-asserted
 * `memberId` holds the meeting's Grammarian slot. The Grammarian owns the WOD in
 * a Toastmasters meeting, so the grammarian slot unlocks WOD editing on the
 * self-serve surface without granting any other meeting-meta edit. If the slot a
 * path keys off is unassigned, that path can't grant. Throws when the meeting
 * does not exist or is locked (#150 choke point).
 */
export async function resolveWordOfTheDayAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<WordOfTheDayAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	assertMeetingNotLocked(meeting.status);
	const clubId = meeting.clubId;
	const { tmodMemberId, grammarianMemberId } = await loadRoleSlotAssignees(
		input.meetingId,
	);

	if (await resolveAdminGrant(input.sessionUserId, clubId)) {
		return {
			clubId,
			allowed: true,
			via: "admin",
			tmodMemberId,
			grammarianMemberId,
		};
	}

	if (
		input.selfMemberId &&
		tmodMemberId &&
		input.selfMemberId === tmodMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "tmod-self-assert",
			tmodMemberId,
			grammarianMemberId,
		};
	}

	if (
		input.selfMemberId &&
		grammarianMemberId &&
		input.selfMemberId === grammarianMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "grammarian-self-assert",
			tmodMemberId,
			grammarianMemberId,
		};
	}

	return {
		clubId,
		allowed: false,
		via: null,
		tmodMemberId,
		grammarianMemberId,
	};
}
