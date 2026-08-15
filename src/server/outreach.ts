// Legacy entry points, retained so PR 1 changes no client file. They are thin
// delegates onto `attendance-plan-logic` and are deleted in PR 2 when the panel
// calls `setPlannedAttendance` directly. "Contacted" is now one rung of the
// ladder (`reached_out`) rather than the presence of a row in its own table.
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { clearPlanStatus, setPlanStatus } from "./attendance-plan-logic";
import { requireClubRole, requireMemberInClub, requireUser } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

/** Load a meeting's status (for the ADR-0012 lock) and its OWNING club, or throw
 *  if missing. The club comes from the meeting, not the payload (#396): gating on
 *  a client-supplied `clubId` would let an admin of club A act on club B's
 *  meeting and file the row under A.
 *
 *  This necessarily runs BEFORE `requireClubRole` — the role check needs a club
 *  and the meeting is the only trustworthy source of one — so a non-member gets
 *  "Meeting not found." rather than a permission error, i.e. it answers "does
 *  this meeting id exist". Deliberately accepted: meeting existence is already
 *  public (`getMeeting` / `getPublicMeetingByKey` take no session and the
 *  `/club/:clubId/meeting/:key` page is anonymous-readable), so the ordering
 *  discloses nothing that isn't already world-readable, and the alternative —
 *  pre-gating on the payload's `clubId` — reintroduces exactly the trust in
 *  client-supplied club ids that #396 removed. */
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

const contactedSchema = z.object({
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	/** Deprecated as an authority: the club is derived from `meetingId`. */
	clubId: z.string().uuid(),
	/** How the ask happened. Recorded in activity_log.detail only. */
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/**
 * Mark a member "contacted" for a meeting (#340) — the `reached_out` rung.
 * Admin/VPE-only officer record (unlike the self-serve setAvailability).
 * Idempotent (the seam upserts). The actor is the resolved officer membership —
 * never trusted from the client. `membership.id` is null under a read_write
 * impersonation session; `logActivity` attributes that case to the impersonating
 * superadmin automatically (via the request-scoped marker set by
 * `requireClubRole`), so passing it straight through as `actorMemberId` is safe.
 *
 * FLOOR-ONLY, via `demoteFrom: ["reached_out"]`. The tables were separate before
 * the consolidation, so this write could not touch a member's own answer; now
 * they share a row, and a plain upsert would let "contacted" overwrite ANY rung
 * the member currently holds. That was reachable, not theoretical: the officer's
 * page renders, the member answers from their phone, the officer ticks the
 * checkbox that was already on screen. Two rungs could be lost that way and both
 * mattered — a `not_coming` decline (which also drops them off the meeting
 * page's Not Available list and the assign picker's warning, so the VPE hands
 * them a role they already declined) and a `coming`, reachable by claiming a
 * slot and then releasing it, since `releaseSlot` leaves the plan row alone.
 * Enforcing it in the upsert's `setWhere` rather than by re-reading first also
 * makes it immune to the race, which no amount of UI freshness would have been.
 */
export const setContacted = createServerFn({ method: "POST" })
	.validator((i: unknown) => contactedSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const meeting = await loadMeeting(data.meetingId);
		const membership = await requireClubRole(user.id, meeting.clubId, [
			"admin",
		]);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);

		await setPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			status: "reached_out",
			actorMemberId: membership.id,
			via: data.via,
			demoteFrom: ["reached_out"],
		});

		return { ok: true as const };
	});

/**
 * Clear a member's "contacted" mark for a meeting (#340). Admin/VPE-only.
 *
 * `onlyFrom: ["reached_out"]` keeps this exactly as narrow as it was before the
 * consolidation. It used to delete a row in the separate "contacted" table, so
 * it was structurally incapable of touching a member's own answer; against the
 * merged row a status-blind delete would wipe a `not_coming` or `coming` too.
 * Unticking "contacted" now means what it says — it removes the ask, and a rung
 * the MEMBER put there is left alone rather than relying on the panel never
 * offering the checkbox.
 */
export const clearContacted = createServerFn({ method: "POST" })
	.validator((i: unknown) => contactedSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const meeting = await loadMeeting(data.meetingId);
		const membership = await requireClubRole(user.id, meeting.clubId, [
			"admin",
		]);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);

		await clearPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId: membership.id,
			onlyFrom: ["reached_out"],
		});

		return { ok: true as const };
	});
