// Guest-assignment DB logic (#151), split out from `guests.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { guests, meetings, roleSlots } from "#/db/schema";
import { GUEST_IS_NOW_A_MEMBER_MESSAGE } from "#/lib/guest-convert";
import { toStoredPhone } from "#/lib/phone";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

// Either the pooled client or a caller's transaction, so this can run inside a
// batch that is already holding row locks.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Contact fields for a brand-new club guest (name required, contact optional). */
export type NewGuestInput = {
	name: string;
	email?: string | null;
	phone?: string | null;
};

/** A club's guests, for attendance and assignment pickers. Club-scoped, name-ordered.
 *  Includes lost guests so returning visitors can reuse their existing record.
 *  Excludes joined guests — they are members now and get assigned as members. */
export async function listClubGuests(clubId: string) {
	return db
		.select({
			id: guests.id,
			name: guests.name,
			stage: guests.stage,
			email: guests.email,
			phone: guests.phone,
		})
		.from(guests)
		.where(
			and(
				eq(guests.clubId, clubId),
				inArray(guests.stage, ["prospect", "following_up", "lost"]),
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
export async function applyAssignGuestToSlot(
	input: {
		slotId: string;
		guestId?: string | null;
		newGuest?: NewGuestInput;
		actorMemberId: string | null;
	},
	/**
	 * Which connection to run on. Defaults to the pooled client, so every
	 * existing caller is unchanged — it opens its own transaction exactly as
	 * before.
	 *
	 * `assign_roles` passes its `tx` (#809), and that is the whole point of the
	 * parameter: a batch mixing members, guests and clears must apply entirely
	 * or not at all, and a guest assignment that opened its OWN transaction
	 * would commit independently of the rest. It would also take a second
	 * pooled connection while the caller's transaction holds `FOR UPDATE` row
	 * locks — the pool is 10 and nothing bounds a pool wait.
	 *
	 * Every read below runs on `conn` too, not only the writes. Threading the
	 * transaction into `db.transaction` and leaving the slot SELECT and
	 * `loadClubDefaultCountryCode` on `db` would take that second connection
	 * anyway, which is the failure this parameter exists to prevent.
	 *
	 * Given a transaction, `conn.transaction` opens a SAVEPOINT rather than a
	 * second transaction: a throw in here still aborts the caller's batch,
	 * because the error propagates.
	 */
	conn: DbOrTx = db,
): Promise<{ clubId: string; guestId: string }> {
	const [slot] = await conn
		.select({
			id: roleSlots.id,
			assignedMemberId: roleSlots.assignedMemberId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!slot) throw new Error("Role not found.");

	// The lock choke point (#150), which this seam has never had. Every other
	// way onto an agenda asserts it — `claimSlot` and `releaseSlotCore` in their
	// own bodies, `reassignSlotCore` under its row lock — and a guest
	// assignment is an agenda mutation like any other, so a completed meeting
	// must refuse it too. Until #809 it did not: `assignGuestSlot` gates on the
	// club admin role and nothing else, so an admin could put a visitor on a
	// locked agenda from the browser.
	//
	// Found by the review of #809, which needed to state where each of the
	// three apply arms enforces the lock and could not say it truthfully for
	// this one. `assign_roles` blocks a locked meeting up front and holds the
	// meeting row `FOR UPDATE` for the batch, so that path was covered — but by
	// a lock whose load-bearing role nothing recorded, rather than by the
	// assertion its siblings make.
	assertMeetingNotLocked(slot.meetingStatus);

	// Club default country code for E.164 normalization on write (#295).
	const cc = await loadClubDefaultCountryCode(slot.clubId, conn);

	return conn.transaction(async (tx) => {
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
					phone: toStoredPhone(input.newGuest.phone, cc),
				})
				.returning({ id: guests.id });
			if (!created) throw new Error("Failed to create guest.");
			guestId = created.id;
		} else if (input.guestId) {
			const [existing] = await tx
				.select({
					id: guests.id,
					name: guests.name,
					convertedMembershipId: guests.convertedMembershipId,
				})
				.from(guests)
				.where(
					and(eq(guests.id, input.guestId), eq(guests.clubId, slot.clubId)),
				)
				.limit(1);
			if (!existing) throw new Error("Guest not found in this club.");
			// A guest who is now a member must be assigned AS that member (#637).
			// Putting `assigned_guest_id` on the slot would re-split a human whose
			// guest and member records were just joined up (#635) — and the caller
			// that made this reachable was a picker showing every guest in the club
			// regardless of stage, so this refusal is what protects the invariant
			// from the NEXT such caller rather than only from that one.
			if (existing.convertedMembershipId) {
				throw new Error(GUEST_IS_NOW_A_MEMBER_MESSAGE(existing.name));
			}
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
