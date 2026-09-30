// Guest-assignment DB logic (#151), split out from `guests.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { guests, meetings, members, roleSlots } from "#/db/schema";
import { GUEST_IS_NOW_A_MEMBER_MESSAGE } from "#/lib/guest-convert";
import { toStoredPhone } from "#/lib/phone";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import {
	type BroughtCount,
	countBroughtByMember,
	GUEST_TEXT_MAX,
	type GuestIntroducerRow,
	type GuestKind,
	normalizeHomeClub,
	type UpdateGuestProfileInput,
} from "./guest-pipeline-schemas";
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

/** `applyUpdateGuestProfile` refuses an introducer who is not in the guest's club. */
export const INTRODUCER_NOT_IN_CLUB_MESSAGE =
	"The member who introduced this guest must be on this club's roster.";

/** `applyUpdateGuestProfile` re-checks the home-club cap the schema applies. */
export const HOME_CLUB_TOO_LONG_MESSAGE = "That club name is too long.";

/** One member the "Introduced by" picker offers. */
export interface IntroducerOption {
	id: string;
	name: string;
	/** `inactive` members stay pickable — see `applyUpdateGuestProfile`. */
	status: "active" | "inactive";
}

export interface GuestProfile {
	kind: GuestKind;
	homeClub: string | null;
	introducedByMemberId: string | null;
	roster: IntroducerOption[];
}

/**
 * What the guest edit dialog needs for the kind / home club / introducer fields
 * (#1050): the stored three, read fresh each time the dialog opens, and the
 * club's roster for the picker. Null when the guest is not in this club.
 *
 * The roster is EVERY membership row of this club, inactive included — the
 * same set `applyUpdateGuestProfile` accepts and `loadLinkCandidates` offers.
 */
export async function loadGuestProfile(
	clubId: string,
	guestId: string,
): Promise<GuestProfile | null> {
	const [guest] = await db
		.select({
			kind: guests.kind,
			homeClub: guests.homeClub,
			introducedByMemberId: guests.introducedByMemberId,
		})
		.from(guests)
		.where(and(eq(guests.id, guestId), eq(guests.clubId, clubId)))
		.limit(1);
	if (!guest) return null;
	const roster = await db
		.select({ id: members.id, name: members.name, status: members.status })
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(asc(members.name));
	return { ...guest, roster };
}

/** One guest's kind / home club / introducer, for VP Membership's rows. */
export interface GuestProfileRow extends GuestIntroducerRow {
	kind: GuestKind;
	homeClub: string | null;
}

/**
 * Every guest's kind, home club and introducer in this club, plus the
 * per-member "brought" counts (#1050) — derived from these same rows by
 * `countBroughtByMember`, so the tally always matches what the page lists.
 *
 * The introducer's name comes from a join that is scoped to THIS club as well
 * as to the id. `introduced_by_member_id` is a bare FK to `members`, which
 * the database does not tie to the guest's club; the write path refuses a
 * cross-club id, and this join is the read side of the same boundary, so a
 * row written some other way names nobody rather than another club's member.
 */
export async function loadGuestProfiles(clubId: string): Promise<{
	rows: GuestProfileRow[];
	brought: BroughtCount[];
}> {
	const rows = await db
		.select({
			guestId: guests.id,
			kind: guests.kind,
			homeClub: guests.homeClub,
			introducedByMemberId: guests.introducedByMemberId,
			introducedByName: members.name,
		})
		.from(guests)
		.leftJoin(
			members,
			and(
				eq(members.id, guests.introducedByMemberId),
				eq(members.clubId, clubId),
			),
		)
		.where(eq(guests.clubId, clubId));
	return { rows, brought: countBroughtByMember(rows) };
}

/**
 * Set a guest's kind, home club and introducer (#1050). Club-scoped; the
 * caller gates on the club admin role, the same gate as every guest write.
 *
 * - `homeClub` goes through `normalizeHomeClub`: trimmed, blank is null, and
 *   CLEARED for a Visitor (criterion 1's "invalid combination"). The length cap
 *   is the schema's; it is re-checked here so a caller that skipped the schema
 *   cannot write an unbounded value.
 * - `introducedByMemberId` must be a membership of THIS club. The FK only says
 *   the member exists somewhere; without this check an officer could record
 *   another club's member as the introducer, and the VP Membership view would
 *   then count a stranger's guests. "A member of this club" means any
 *   membership row with this `club_id`, INACTIVE INCLUDED — the rule
 *   `applyLinkGuestToMember` and its roster picker use. A former member who
 *   brought a guest last year still brought them; history an import carries
 *   in names people who have since lapsed.
 * - Null clears the introducer. Omitting it clears it too, like the contact
 *   fields on `applyUpdateGuest`: the form always sends what it shows.
 */
export async function applyUpdateGuestProfile(
	input: UpdateGuestProfileInput,
): Promise<{ ok: true }> {
	const homeClub = normalizeHomeClub(input.kind, input.homeClub);
	if (homeClub !== null && homeClub.length > GUEST_TEXT_MAX) {
		throw new Error(HOME_CLUB_TOO_LONG_MESSAGE);
	}
	const introducedByMemberId = input.introducedByMemberId ?? null;

	const [guest] = await db
		.select({ id: guests.id })
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) throw new Error("Guest not found in this club.");

	if (introducedByMemberId !== null) {
		const [introducer] = await db
			.select({ id: members.id })
			.from(members)
			.where(
				and(
					eq(members.id, introducedByMemberId),
					eq(members.clubId, input.clubId),
				),
			)
			.limit(1);
		if (!introducer) throw new Error(INTRODUCER_NOT_IN_CLUB_MESSAGE);
	}

	await db
		.update(guests)
		.set({
			kind: input.kind,
			homeClub,
			introducedByMemberId,
			updatedAt: new Date(),
		})
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)));
	return { ok: true as const };
}
