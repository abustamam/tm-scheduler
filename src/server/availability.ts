import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, memberAvailability } from "#/db/schema";
import { logActivity } from "./activity";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";
import { requireMemberInClub } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

/** Load a meeting's status (for the #150 lock) or throw if it's missing. */
async function meetingStatus(meetingId: string): Promise<string> {
	const [row] = await db
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row.status;
}

const availabilitySchema = z.object({
	/** The member whose availability is being set (the subject). */
	memberId: z.string().uuid(),
	/** Who performed the action. Omitted ⇒ self-service (actor = subject); set
	 *  to an officer's member id when an admin marks someone else unavailable.
	 *  Trust-guarded as a club member, mirroring `claimSlot`/`reassignSlot`. */
	actorMemberId: z.string().uuid().optional(),
	meetingId: z.string().uuid(),
	clubId: z.string().uuid(),
});

/** Mark a member as unavailable for a meeting (presence of row = not available).
 *  Idempotent via onConflictDoNothing. PUBLIC — no session required; trust guard via requireMemberInClub. */
export const setAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const actorMemberId = data.actorMemberId ?? data.memberId;
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);
		if (actorMemberId !== data.memberId)
			await requireMemberInClub(actorMemberId, data.clubId);

		await db
			.insert(memberAvailability)
			.values({ memberId: data.memberId, meetingId: data.meetingId })
			.onConflictDoNothing();

		await logActivity(db, {
			clubId: data.clubId,
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
		const actorMemberId = data.actorMemberId ?? data.memberId;
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);
		if (actorMemberId !== data.memberId)
			await requireMemberInClub(actorMemberId, data.clubId);

		await db
			.delete(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, data.memberId),
					eq(memberAvailability.meetingId, data.meetingId),
				),
			);

		await logActivity(db, {
			clubId: data.clubId,
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
		const actorMemberId = data.actorMemberId ?? data.memberId;
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);
		if (actorMemberId !== data.memberId)
			await requireMemberInClub(actorMemberId, data.clubId);
		const { released } = await releaseSlotsAndMarkUnavailable(db, {
			...data,
			actorMemberId,
		});
		return { ok: true as const, released };
	});
