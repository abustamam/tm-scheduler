import { and, eq } from "drizzle-orm";
import type { db } from "#/db";
import { roleSlots } from "#/db/schema";
import { logActivity } from "./activity";
import { setPlanStatus } from "./attendance-plan-logic";

type Database = typeof db;

/**
 * Release every role a member holds in a meeting and record them `not_coming`,
 * in one transaction (#204). Pure db logic so it's directly testable; the server
 * fn (`markUnavailableReleasing`) wraps it with the meeting-lock + membership
 * guards. Release mirrors `releaseSlot`: slot → open, assignee + speech
 * unlinked (the speech persists, ADR-0009).
 */
export async function releaseSlotsAndMarkUnavailable(
	database: Database,
	args: {
		/** The member being marked unavailable (whose roles are released). */
		memberId: string;
		/** Who performed the action — self, or an officer acting on their behalf.
		 *  Attributed in the activity log; an ABSENT actor defaults to `memberId`
		 *  (self-service). An explicit `null` is a decision, not an omission — it's
		 *  what an impersonated write resolves to (#396/#246), and `logActivity`
		 *  stamps the real superadmin for it — so it must NOT fall back to the
		 *  member, or the write lands under their name. */
		actorMemberId?: string | null;
		meetingId: string;
		clubId: string;
	},
): Promise<{ released: number }> {
	const actorMemberId =
		args.actorMemberId === undefined ? args.memberId : args.actorMemberId;
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

		// Inside the caller's transaction, which is why the seam takes a `DbOrTx`:
		// the release and the "not coming" answer commit together or not at all.
		// It logs its own `plan_set` activity, so there is no separate
		// availability_set row here any more.
		await setPlanStatus(tx, {
			memberId: args.memberId,
			meetingId: args.meetingId,
			clubId: args.clubId,
			status: "not_coming",
			actorMemberId,
		});

		for (const slot of released) {
			await logActivity(tx, {
				clubId: args.clubId,
				actorMemberId,
				action: "release",
				targetType: "slot",
				targetId: slot.id,
				detail: { fromMemberId: args.memberId },
			});
		}
		return { released: released.length };
	});
}
