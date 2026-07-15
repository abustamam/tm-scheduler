// Guest-assignment DB logic (#151), split out from `guests.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { guests, meetings, roleSlots } from "#/db/schema";
import { logActivity } from "./activity";

/** Contact fields for a brand-new club guest (name required, contact optional). */
export type NewGuestInput = {
	name: string;
	email?: string | null;
	phone?: string | null;
};

/** A club's guests, for the admin assign picker. Club-scoped, name-ordered.
 *  Excludes `joined` (converted) guests — they are members now and get assigned
 *  as members — and `lost` guests; only live prospects appear (#208 / ADR-0018). */
export async function listClubGuests(clubId: string) {
	return db
		.select({
			id: guests.id,
			name: guests.name,
			email: guests.email,
			phone: guests.phone,
		})
		.from(guests)
		.where(
			and(
				eq(guests.clubId, clubId),
				inArray(guests.stage, ["prospect", "following_up"]),
			),
		)
		.orderBy(asc(guests.name));
}

/**
 * Assign a non-member guest to a role slot (#151): either an existing club
 * `guestId` or a `newGuest` payload (name + optional contact) that creates the
 * guest first. The assignment is MUTUALLY EXCLUSIVE with a member — assigning a
 * guest clears `assigned_member_id` (and any attached Person-owned speech, which
 * a guest cannot own — ADR-0009), so the "at most one assignee" invariant holds
 * in logic as well as the DB check constraint. The slot moves to `claimed`.
 *
 * Admin-authorized by the caller (the server fn gates on the club admin role);
 * this helper trusts that gate and only validates the guest is club-scoped.
 * Returns the slot's club id and the resolved guest id.
 */
export async function applyAssignGuestToSlot(input: {
	slotId: string;
	guestId?: string | null;
	newGuest?: NewGuestInput;
	actorMemberId: string | null;
}): Promise<{ clubId: string; guestId: string }> {
	const [slot] = await db
		.select({
			id: roleSlots.id,
			assignedMemberId: roleSlots.assignedMemberId,
			clubId: meetings.clubId,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!slot) throw new Error("Role not found.");

	return db.transaction(async (tx) => {
		let guestId: string;
		if (input.newGuest) {
			const name = input.newGuest.name.trim();
			if (!name) throw new Error("A guest name is required.");
			const [created] = await tx
				.insert(guests)
				.values({
					clubId: slot.clubId,
					name,
					email: input.newGuest.email?.trim() || null,
					phone: input.newGuest.phone?.trim() || null,
				})
				.returning({ id: guests.id });
			if (!created) throw new Error("Failed to create guest.");
			guestId = created.id;
		} else if (input.guestId) {
			const [existing] = await tx
				.select({ id: guests.id })
				.from(guests)
				.where(
					and(eq(guests.id, input.guestId), eq(guests.clubId, slot.clubId)),
				)
				.limit(1);
			if (!existing) throw new Error("Guest not found in this club.");
			guestId = existing.id;
		} else {
			throw new Error("Provide a guest to assign.");
		}

		// Mutual exclusivity: setting a guest clears the member assignee and any
		// Person-owned speech (a guest speaker slot just shows the name — ADR-0009).
		await tx
			.update(roleSlots)
			.set({
				assignedGuestId: guestId,
				assignedMemberId: null,
				speechId: null,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, slot.id));

		await logActivity(tx, {
			clubId: slot.clubId,
			actorMemberId: input.actorMemberId,
			action: "reassign",
			targetType: "slot",
			targetId: slot.id,
			detail: { fromMemberId: slot.assignedMemberId, guestId },
		});

		return { clubId: slot.clubId, guestId };
	});
}
