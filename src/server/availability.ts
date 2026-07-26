import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, memberAvailability } from "#/db/schema";
import { logActivity } from "./activity";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";
import { requireMemberInClub } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { requireRequestWriteActor } from "./write-actor-logic";

/** Load a meeting's status (for the #150 lock) and its OWNING club, or throw if
 *  it's missing. The club is read from the meeting rather than trusted from the
 *  payload (#396) — otherwise a caller could aim a write at club B's meeting and
 *  file the activity row under club A. */
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

const availabilitySchema = z.object({
	/** The member whose availability is being set (the subject). */
	memberId: z.string().uuid(),
	/** Who performed the action. Omitted ⇒ self-service (actor = subject); set
	 *  to an officer's member id when an admin marks someone else unavailable.
	 *  PUBLIC path, so this is an assertion, not proof — `requireRequestWriteActor`
	 *  club-scopes it and a real session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	meetingId: z.string().uuid(),
	/** Deprecated as an authority: the club is derived from `meetingId`. */
	clubId: z.string().uuid(),
});

/** Mark a member as unavailable for a meeting (presence of row = not available).
 *  Idempotent via onConflictDoNothing. PUBLIC — no session required; trust guard via requireMemberInClub. */
export const setAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await requireRequestWriteActor({
			clubId: meeting.clubId,
			claimedActorMemberId: data.actorMemberId ?? data.memberId,
		});

		await db
			.insert(memberAvailability)
			.values({ memberId: data.memberId, meetingId: data.meetingId })
			.onConflictDoNothing();

		await logActivity(db, {
			clubId: meeting.clubId,
			actorMemberId,
			action: "availability_set",
			targetType: "meeting",
			targetId: data.meetingId,
			detail: { memberId: data.memberId },
		});

		return { ok: true as const };
	});

/** Remove a member's unavailability record for a meeting.
 *  PUBLIC — no session required; trust guard via requireMemberInClub. */
export const clearAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await requireRequestWriteActor({
			clubId: meeting.clubId,
			claimedActorMemberId: data.actorMemberId ?? data.memberId,
		});

		await db
			.delete(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, data.memberId),
					eq(memberAvailability.meetingId, data.meetingId),
				),
			);

		await logActivity(db, {
			clubId: meeting.clubId,
			actorMemberId,
			action: "availability_clear",
			targetType: "meeting",
			targetId: data.meetingId,
			detail: { memberId: data.memberId },
		});

		return { ok: true as const };
	});

/**
 * Mark a member unavailable for a meeting AND release every role they hold in
 * it, atomically (#204). A member can't both hold a role and be absent, so the
 * grid offers this as one confirmed action instead of a contradiction. Release
 * mirrors `releaseSlot` (slot → open, assignee + speech unlinked; speech kept).
 * PUBLIC — trust guard via requireMemberInClub.
 */
export const markUnavailableReleasing = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await requireRequestWriteActor({
			clubId: meeting.clubId,
			claimedActorMemberId: data.actorMemberId ?? data.memberId,
		});
		const { released } = await releaseSlotsAndMarkUnavailable(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId,
		});
		return { ok: true as const, released };
	});
