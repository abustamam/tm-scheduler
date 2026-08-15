import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { attendancePlanStatusEnum, meetings } from "#/db/schema";
import {
	clearPlanStatus,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "./attendance-plan-logic";
import {
	assertClubNotArchived,
	getSessionUser,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	type ResolvedMembership,
	requireClubRole,
	requireMemberInClub,
} from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { resolveWriteActor } from "./write-actor-logic";

/**
 * The planned-attendance write surface (D6, 2026-08-11): one entry point for the
 * whole `reached_out | coming | not_coming` ladder, replacing the four fns that
 * wrote the two now-dropped boolean tables separately. Those keep working as
 * thin delegates until PR 2 repoints the panel here.
 */

// Module-private on purpose. `server-modules.guard.test.ts` lets a server-fn
// module export ONLY `createServerFn`s and types: any other top-level export
// survives into the client bundle and drags `#/db` → `pg` → `Buffer` with it.
const SELF_ONLY_MESSAGE = "You can only change your own planned attendance.";
const OFFICER_ONLY_REACHED_OUT_MESSAGE =
	"Only an officer can record reaching out to someone.";

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
	 *  assertion, not proof — `resolveWriteActor` club-scopes it and a real
	 *  session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	// DERIVED from the pgEnum, never hand-listed. A literal union here would be
	// invisible to `tsc` — a narrower zod enum assigns cleanly into the wider
	// `AttendancePlanStatus` parameter — so a fourth rung added to the database
	// would be silently rejected by the only entry point that writes one. That is
	// the drift #510 hit from the other side.
	status: z.enum(attendancePlanStatusEnum.enumValues),
	/** How the change happened. Recorded in activity_log.detail only. */
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/** Which arm of D6 admitted the caller, plus who to credit. `viaOfficer` is
 *  REPORTED rather than inferred: `actorMemberId === null` happens to mean
 *  "impersonating superadmin" today only because a read-only session falls
 *  through and is rejected below, which is an accident of ordering, not an
 *  invariant a caller should re-derive. */
interface ResolvedActor {
	actorMemberId: string | null;
	viaOfficer: boolean;
}

/** Denials that legitimately mean "not an officer HERE" and so fall through to
 *  the self-only arm. Anything else — a db blip, an archived club — is rethrown
 *  rather than silently demoting a real officer (see the constants' jsdoc). */
const OFFICER_DENIALS: ReadonlySet<string> = new Set([
	NOT_A_MEMBER_MESSAGE,
	NO_PERMISSION_MESSAGE,
]);

/**
 * Resolve the acting member and enforce D6: an officer may set anyone's row, a
 * member may set only their own. Session-less by design — the anonymous
 * roster-pick identity is the dominant path in this product.
 */
async function resolveActor(args: {
	/** ALWAYS the meeting's own club — see `loadMeeting`. */
	clubId: string;
	memberId: string;
	claimedActorMemberId?: string;
}): Promise<ResolvedActor> {
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
		let membership: ResolvedMembership | null = null;
		try {
			membership = await requireClubRole(user.id, args.clubId, ["admin"]);
		} catch (error) {
			if (!OFFICER_DENIALS.has(error instanceof Error ? error.message : "")) {
				throw error;
			}
		}
		if (membership) {
			return { actorMemberId: membership.id, viaOfficer: true };
		}
	}
	// Not an officer here: a plain member, an anonymous roster pick, or a
	// signed-in user with no membership in THIS club. `resolveWriteActor` gives
	// the caller's own membership precedence over anything they asserted, so the
	// comparison below is what stops one member setting another's row.
	const actor = await resolveWriteActor({
		clubId: args.clubId,
		sessionUserId: user?.id ?? null,
		claimedActorMemberId: args.claimedActorMemberId ?? args.memberId,
	});
	if (actor !== args.memberId) throw new Error(SELF_ONLY_MESSAGE);
	return { actorMemberId: actor, viaOfficer: false };
}

/** Set a member's planned attendance for a meeting. */
export const setPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) => planSchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		// FIRST, so an archived club cannot be probed through the different errors
		// the checks below return — the existence oracle #544 set out to close.
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const { actorMemberId, viaOfficer } = await resolveActor({
			clubId: meeting.clubId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		// `reached_out` is an OFFICER's record of having asked, not a self-service
		// answer. Without this, the self-only arm admits it for the caller's own
		// subject — and on the anonymous path "the caller's own subject" is any
		// roster member, because `claimedActorMemberId` defaults to the subject.
		// The officer's outreach list would then show that member as already
		// asked, and they would be skipped.
		if (!viaOfficer && data.status === "reached_out") {
			throw new Error(OFFICER_ONLY_REACHED_OUT_MESSAGE);
		}
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
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const { actorMemberId, viaOfficer } = await resolveActor({
			clubId: meeting.clubId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		return clearPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId,
			// Clearing your OWN answer is self-service, but `reached_out` is not
			// your answer — it is the officer's record of having asked, and before
			// the consolidation deleting it required `requireUser()` +
			// `requireClubRole(admin)` because it lived in its own table. The
			// self-only arm is no barrier here: on the anonymous path
			// `claimedActorMemberId` defaults to the subject, so actor === subject
			// always holds and any roster member is reachable. Officers keep the
			// unrestricted clear; everyone else may only take back a rung a member
			// could have set.
			onlyFrom: viaOfficer ? undefined : SELF_SERVICE_RUNGS,
		});
	});
