import { and, eq } from "drizzle-orm";
import type { db } from "#/db";
import { memberAvailability, roleSlots } from "#/db/schema";
import { logActivity } from "./activity";

type Database = typeof db;

/**
 * Release every role a member holds in a meeting and mark them unavailable, in
 * one transaction (#204). Pure db logic so it's directly testable; the server
 * fn (`markUnavailableReleasing`) wraps it with the meeting-lock + membership
 * guards. Release mirrors `releaseSlot`: slot → open, assignee + speech
 * unlinked (the speech persists, ADR-0009).
 */
export async function releaseSlotsAndMarkUnavailable(
	database: Database,
	args: { memberId: string; meetingId: string; clubId: string },
): Promise<{ released: number }> {
	return database.transaction(async (tx) => {
		const released = await tx
			.update(roleSlots)
			.set({
				assignedMemberId: null,
				assignedGuestId: null,
				status: "open",
				claimedAt: null,
				speechId: null,
			})
			.where(
				and(
					eq(roleSlots.meetingId, args.meetingId),
					eq(roleSlots.assignedMemberId, args.memberId),
				),
			)
			.returning({ id: roleSlots.id });

		await tx
			.insert(memberAvailability)
			.values({ memberId: args.memberId, meetingId: args.meetingId })
			.onConflictDoNothing();

		for (const slot of released) {
			await logActivity(tx, {
				clubId: args.clubId,
				actorMemberId: args.memberId,
				action: "release",
				targetType: "slot",
				targetId: slot.id,
				detail: { fromMemberId: args.memberId },
			});
		}
		await logActivity(tx, {
			clubId: args.clubId,
			actorMemberId: args.memberId,
			action: "availability_set",
			targetType: "meeting",
			targetId: args.meetingId,
		});

		return { released: released.length };
	});
}
