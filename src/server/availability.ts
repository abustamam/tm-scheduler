import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { memberAvailability } from "#/db/schema";
import { logActivity } from "./activity";
import { requireMemberInClub } from "./guards";

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
