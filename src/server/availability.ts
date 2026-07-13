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
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	clubId: z.string().uuid(),
});

/** Mark a member as unavailable for a meeting (presence of row = not available).
 *  Idempotent via onConflictDoNothing. PUBLIC — no session required; trust guard via requireMemberInClub. */
export const setAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);

		await db
			.insert(memberAvailability)
			.values({ memberId: data.memberId, meetingId: data.meetingId })
			.onConflictDoNothing();

		await logActivity(db, {
			clubId: data.clubId,
			actorMemberId: data.memberId,
			action: "availability_set",
			targetType: "meeting",
			targetId: data.meetingId,
		});

		return { ok: true as const };
	});

/** Remove a member's unavailability record for a meeting.
 *  PUBLIC — no session required; trust guard via requireMemberInClub. */
export const clearAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);

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
			actorMemberId: data.memberId,
			action: "availability_clear",
			targetType: "meeting",
			targetId: data.meetingId,
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
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);
		const { released } = await releaseSlotsAndMarkUnavailable(db, data);
		return { ok: true as const, released };
	});
