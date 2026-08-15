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
 * WIDER than it was: this used to INSERT into its own table, and it now upserts
 * the one plan row, so ticking "contacted" on a member who is `not_coming`
 * overwrites their decline. That is reachable through a stale list, not just in
 * theory: the officer's page renders, the member declines from their phone, the
 * officer ticks the checkbox that was already on screen, and the decline is
 * gone. PR 2's panel replaces the checkbox with an explicit rung picker over
 * live state.
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
		});

		return { ok: true as const };
	});

/**
 * Clear a member's "contacted" mark for a meeting (#340). Admin/VPE-only.
 *
 * WIDER than it was: this used to delete only the per-meeting "contacted"
 * row, dropped in this PR, and it now clears the whole plan row, so clearing
 * "contacted" on a member who is `not_coming` would wipe that answer too.
 * Unreachable through the UI — `deriveOutreach` never lists an unavailable
 * member, so no checkbox exists for them to uncheck — and PR 2 replaces this
 * fn with the panel's explicit rung picker. Stated here so the next reader
 * does not have to re-derive it.
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
		});

		return { ok: true as const };
	});
