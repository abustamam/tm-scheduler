import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { clearPlanStatus, setPlanStatus } from "./attendance-plan-logic";
import {
	assertClubNotArchived,
	getSessionUser,
	requireClubRole,
	requireMemberInClub,
} from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { requestWriteActor } from "./write-actor-logic";

/**
 * The planned-attendance write surface (D6, 2026-08-11): one entry point for the
 * whole `reached_out | coming | not_coming` ladder, replacing the four fns that
 * wrote `member_availability` and `meeting_outreach` separately. Those keep
 * working as thin delegates until PR 2 repoints the panel here.
 */

// Module-private on purpose. `server-modules.guard.test.ts` lets a server-fn
// module export ONLY `createServerFn`s and types: any other top-level export
// survives into the client bundle and drags `#/db` → `pg` → `Buffer` with it.
const SELF_ONLY_MESSAGE = "You can only change your own planned attendance.";

/** Meeting status + OWNING club. The club comes from the meeting, never the
 *  payload (#396): gating on a client-supplied `clubId` would let an admin of
 *  club A act on club B's meeting and file the row under A. The payload has no
 *  `clubId` field at all, so there is nothing to be tempted by. */
async function loadMeeting(
	meetingId: string,
): Promise<{ status: string; clubId: string }> {
	const [row] = await db
		.select({ status: meetings.status, clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row;
}

const planSchema = z.object({
	/** The member whose plan is being set (the subject). */
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	/** Who performed it. Omitted ⇒ self-service. PUBLIC path, so this is an
	 *  assertion, not proof — `requestWriteActor` club-scopes it and a real
	 *  session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	status: z.enum(["reached_out", "coming", "not_coming"]),
	/** How the change happened. Recorded in activity_log.detail only. */
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/**
 * Resolve the acting member and enforce D6: an officer may set anyone's row, a
 * member may set only their own. Session-less by design — the anonymous
 * roster-pick identity is the dominant path in this product — so it also gates
 * on `clubs.archived_at`, which the other session-less writers still miss
 * (#555). Returns the actor id to attribute the write to.
 */
async function resolveActor(args: {
	/** ALWAYS the meeting's own club — see `loadMeeting`. */
	clubId: string;
	memberId: string;
	claimedActorMemberId?: string;
}): Promise<string | null> {
	// The only archive gate on the anonymous path: `requireMembership` (which
	// carries the check for every authed write) is never reached by a caller
	// with no session.
	await assertClubNotArchived(args.clubId);
	const user = await getSessionUser();
	if (user) {
		// Branch on whether the CALL succeeded, NEVER on `membership.id` being
		// truthy. `requireClubRole` already resolves the impersonation path: a
		// superadmin with an active read_write session comes back as a memberless
		// effective-admin whose `id` is null (#246), which `setPlanStatus`
		// documents as a decision rather than an omission — `logActivity` stamps
		// the real superadmin for it. `if (membership.id)` would push exactly that
		// principal down into the self-only branch below, where they hold no
		// membership, and reject the write.
		const membership = await requireClubRole(user.id, args.clubId, [
			"admin",
		]).catch(() => null);
		if (membership) return membership.id;
	}
	// Not an officer here: a plain member, an anonymous roster pick, or a
	// signed-in user with no membership in THIS club. `requestWriteActor` gives
	// the caller's own membership precedence over anything they asserted, so the
	// comparison below is what stops one member setting another's row.
	const actor = await requestWriteActor({
		clubId: args.clubId,
		claimedActorMemberId: args.claimedActorMemberId ?? args.memberId,
	});
	if (actor !== args.memberId) throw new Error(SELF_ONLY_MESSAGE);
	return actor;
}

/** Set a member's planned attendance for a meeting. */
export const setPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) => planSchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await resolveActor({
			clubId: meeting.clubId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		return setPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			status: data.status,
			actorMemberId,
			via: data.via,
		});
	});

/** Clear a member's planned attendance back to "no answer" (row absent). */
export const clearPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		planSchema.omit({ status: true, via: true }).parse(i),
	)
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await resolveActor({
			clubId: meeting.clubId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		return clearPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId,
		});
	});
