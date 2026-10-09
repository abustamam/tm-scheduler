// Guest-assignment DB logic (#151), split out from `guests.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	meetings,
	members,
	people,
	peopleEmailBackup,
	roleSlots,
} from "#/db/schema";
import { GUEST_IS_NOW_A_MEMBER_MESSAGE } from "#/lib/guest-convert";
import {
	type BroughtCount,
	countBroughtByMember,
	GUEST_TEXT_MAX,
	type GuestIntroducerRow,
	type GuestProfileFields,
	HOME_CLUB_TOO_LONG_MESSAGE,
	normalizeHomeClub,
} from "#/lib/guest-profile";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { toStoredPhone } from "#/lib/phone";
import { unreferencedUnboundPerson } from "./account-link-logic";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import type { UpdateGuestProfileInput } from "./guest-pipeline-schemas";
import { meetingAcceptsWrite } from "./meeting-write-gate";
import { PLAN_ACCEPTING_CANCELLED } from "./meeting-write-options";

// Either the pooled client or a caller's transaction, so this can run inside a
// batch that is already holding row locks.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * What a refused read-then-lock re-read says (ADR-0031). A path that must read a
 * row to learn which clubs or Persons to lock reads it without locking, takes
 * the locks in protocol order, and re-reads; when the set it locked is no longer
 * the set the row names, the work is refused with this and nothing is written.
 */
export const RECORD_CHANGED_MESSAGE = "This record changed. Try again.";

/** What `createGuestRecord` takes: a `guests` insert, minus the Person it mints. */
export type NewGuestRecord = Omit<typeof guests.$inferInsert, "personId"> & {
	/**
	 * Point the guest row at this EXISTING Person instead of minting one. For a
	 * row that already IS somebody's Person, such as a converted guest in the
	 * seed (`guests.person_id` equals its membership's Person). Nothing in the
	 * app's own write paths passes it today.
	 */
	personId?: string;
};

/**
 * The name-only Person a guest gets: the migration's backfill shape, and the one
 * `createGuestRecord` and `ensureGuestPerson` both mint. Contact is not on it
 * (#1125 moves it, and an address typed on the anonymous guest book is nobody's
 * sign-in key until a member vouches for it).
 */
async function mintNameOnlyPerson(
	tx: DbOrTx,
	guest: { name: string; preferredName?: string | null },
): Promise<string> {
	const [person] = await tx
		.insert(people)
		.values({ name: guest.name, preferredName: guest.preferredName ?? null })
		.returning({ id: people.id });
	if (!person) throw new Error("Failed to create person.");
	return person.id;
}

/** Take back a Person this transaction minted and then did not use. */
async function discardMintedPerson(
	tx: DbOrTx,
	personId: string,
): Promise<void> {
	await tx.delete(people).where(eq(people.id, personId));
}

/** What a client-supplied guest id that belongs to ANOTHER club answers. */
export const GUEST_NOT_IN_CLUB_MESSAGE = "Guest not found in this club.";

/**
 * The ONLY way a `guests` row is inserted (#1124, ADR-0031): a guest is a
 * Person, so this mints the Person `{ name, preferredName }` and the guest row
 * pointing at it, in one transaction. `guest-insert.guard.test.ts` fails on any
 * other insert into the guests table in non-test source, comments included.
 *
 * A guest's email and phone are still written to the `guests` row here; moving
 * them onto the Person is #1125.
 *
 * Always opens `conn.transaction`: given the pooled client that is the
 * transaction the two inserts need, and given a caller's transaction it is a
 * SAVEPOINT, so a failure rolls back the Person too and a caller's batch still
 * aborts because the error propagates.
 *
 * An `id` the caller supplied (a client-side idempotency key) that already
 * exists is a replay, not an error: the guest row is NOT written again and the
 * Person minted for it is deleted again, so a replay leaves no orphan Person.
 * `created` says which happened. Without an `id` nothing can conflict.
 *
 * A replay is only a replay in the SAME club. The id is client-supplied, so one
 * that names another club's guest is refused rather than answered: returning it
 * would let an officer attach a stranger club's guest to their own meeting.
 */
export async function createGuestRecord(
	conn: DbOrTx,
	input: NewGuestRecord,
): Promise<{ id: string; created: boolean }> {
	const { personId: existingPersonId, ...row } = input;
	return conn.transaction(async (tx) => {
		const personId = existingPersonId ?? (await mintNameOnlyPerson(tx, row));
		const [guest] = await tx
			.insert(guests)
			.values({ ...row, personId })
			.onConflictDoNothing({ target: guests.id })
			.returning({ id: guests.id });
		if (guest) return { id: guest.id, created: true };

		const [existing] = row.id
			? await tx
					.select({ clubId: guests.clubId })
					.from(guests)
					.where(eq(guests.id, row.id))
					.limit(1)
			: [];
		if (!row.id || !existing) throw new Error("Failed to create guest.");
		// Another club's guest: nothing is written, and throwing rolls back the
		// Person minted above (this transaction, or the savepoint inside a caller's).
		if (existing.clubId !== row.clubId)
			throw new Error(GUEST_NOT_IN_CLUB_MESSAGE);
		// A replay of a client-supplied id. The Person above was minted for a row
		// that was not written, so it goes; one the caller named is theirs.
		if (!existingPersonId) await discardMintedPerson(tx, personId);
		return { id: row.id, created: false };
	});
}

/**
 * The guest's Person, creating one when `person_id` is null (#1124).
 *
 * A null can only come from the OLD container during the deploy swap that
 * shipped the column, or from a test fixture that inserts directly. The Person
 * has the shape the migration's backfill gave everyone else: name only. Convert,
 * and #1127's link and separate, call this before they rely on a Person.
 *
 * The caller holds the guest row `FOR UPDATE`, which is what makes the
 * check-then-set safe; the UPDATE still carries `person_id IS NULL` so that a
 * second writer that got there first is read, not overwritten.
 */
export async function ensureGuestPerson(
	tx: DbOrTx,
	guestId: string,
): Promise<string> {
	const [guest] = await tx
		.select({
			personId: guests.personId,
			name: guests.name,
			preferredName: guests.preferredName,
		})
		.from(guests)
		.where(eq(guests.id, guestId))
		.limit(1);
	if (!guest) throw new Error("Guest not found.");
	if (guest.personId) return guest.personId;

	const minted = await mintNameOnlyPerson(tx, guest);
	const set = await tx
		.update(guests)
		.set({ personId: minted })
		.where(and(eq(guests.id, guestId), isNull(guests.personId)))
		.returning({ id: guests.id });
	if (set.length > 0) return minted;
	// Lost the race: someone set it between the read and the write. Theirs wins.
	await discardMintedPerson(tx, minted);
	const [now] = await tx
		.select({ personId: guests.personId })
		.from(guests)
		.where(eq(guests.id, guestId))
		.limit(1);
	if (!now?.personId) throw new Error("Failed to create person.");
	return now.personId;
}

/**
 * After an undo or an unlink (#1124): a guest row that still names a Person who
 * holds ANY membership is pointed at a fresh name-only Person instead (the
 * backfill's shape). Returns the new Person's id, or null when the guest's
 * Person holds none and nothing changed.
 *
 * Why it must. The backfill points a converted or linked guest at its
 * membership's Person, and after the undo or the unlink that Person is still a
 * member. Left there, the next convert adopts the member's Person, which takes
 * the REUSE branch (it reactivates a lapsed row, demotes, closes officer terms,
 * and skips the #617 name-clash refusal) and, for a row converted before #759,
 * attaches another club's Person to this one.
 *
 * The caller holds the club write lock, the guest's Person `FOR UPDATE` and the
 * guest row `FOR UPDATE`, in that order, and has already deleted or restored the
 * membership it is undoing: the question is asked AFTER that.
 */
export async function separateGuestFromMemberPerson(
	tx: DbOrTx,
	guestId: string,
): Promise<string | null> {
	const [guest] = await tx
		.select({
			personId: guests.personId,
			name: guests.name,
			preferredName: guests.preferredName,
		})
		.from(guests)
		.where(eq(guests.id, guestId))
		.limit(1);
	if (!guest?.personId) return null;
	const [held] = await tx
		.select({ id: members.id })
		.from(members)
		.where(eq(members.personId, guest.personId))
		.limit(1);
	if (!held) return null;
	const fresh = await mintNameOnlyPerson(tx, guest);
	await tx
		.update(guests)
		.set({ personId: fresh })
		.where(eq(guests.id, guestId));
	return fresh;
}

/**
 * Delete a guest's Person once nothing references it (#1124): after the guest
 * row is deleted, or after a link points the guest at a member's Person. The
 * conditions travel in the DELETE's own WHERE (`unreferencedUnboundPerson()`: no
 * sign-in, no membership, no other guest row, no speech or enrolment to cascade
 * away), so a Person that gained a reference since the caller looked is kept.
 *
 * Without it every deleted guest leaves a Person behind that no club names, no
 * removal record points at, and not even a permanent club delete can collect.
 * The caller holds the club write lock and the Person `FOR UPDATE`, which is
 * why this path, unlike the undo and unlink, takes the strong mode: it deletes.
 */
export async function deleteGuestPersonIfUnreferenced(
	tx: DbOrTx,
	personId: string,
): Promise<boolean> {
	const gone = await tx
		.delete(people)
		.where(and(eq(people.id, personId), unreferencedUnboundPerson()))
		.returning({ id: people.id });
	if (gone.length === 0) return false;
	// The same clean-up a club delete does for the Persons it deletes (#914): the
	// address snapshot in `people_email_backup` has no foreign key, so it would
	// outlive the Person it is a copy of. Only that table, as there; the other
	// temporary backups are left to their own drop, as a club delete leaves them.
	await tx
		.delete(peopleEmailBackup)
		.where(eq(peopleEmailBackup.personId, personId));
	return true;
}

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
	//
	// By write class (#1135), accepting `cancelled` (`PLAN_ACCEPTING_CANCELLED`):
	// a cancelled meeting is refused in the statement below, after the guest
	// checks (#1057). The statement refuses both statuses.
	assertMeetingAccepts(slot.meetingStatus, "plan", PLAN_ACCEPTING_CANCELLED);

	// Club default country code for E.164 normalization on write (#295).
	const cc = await loadClubDefaultCountryCode(slot.clubId, conn);

	return conn.transaction(async (tx) => {
		let guestId: string;
		if (input.newGuest) {
			const name = input.newGuest.name.trim();
			if (!name) throw new Error("A guest name is required.");
			const created = await createGuestRecord(tx, {
				clubId: slot.clubId,
				name,
				email: input.newGuest.email?.trim() || null,
				phone: toStoredPhone(input.newGuest.phone, cc),
			});
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
		//
		// The meeting's status rides in the statement (#1057, `meetingAcceptsWrite`,
		// the same predicate the slot writers in `slots-logic` carry): a cancelled
		// meeting keeps its assignments until restored, and this write drops a
		// speech a restore could not bring back. The slot read above took no row
		// lock, so a zero-row result is not proof of WHICH predicate failed; the
		// status is re-read for the sentence, and a slot that vanished meanwhile
		// gets the not-found answer it would have got.
		const assigned = await tx
			.update(roleSlots)
			.set({
				assignedGuestId: guestId,
				assignedMemberId: null,
				speechId: null,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(
				and(
					eq(roleSlots.id, slot.id),
					meetingAcceptsWrite(tx, "plan", roleSlots.meetingId),
				),
			)
			.returning({ id: roleSlots.id });
		if (assigned.length === 0) {
			const [status] = await tx
				.select({ status: meetings.status })
				.from(roleSlots)
				.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
				.where(eq(roleSlots.id, slot.id))
				.limit(1);
			if (status) assertMeetingAccepts(status.status, "plan");
			throw new Error("Role not found.");
		}

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

/** `applyUpdateGuestProfile` refuses a joined guest as their own introducer. */
export const GUEST_CANNOT_INTRODUCE_SELF_MESSAGE =
	"A guest can't be recorded as having introduced themselves.";

/** One member the "Introduced by" picker offers. */
export interface IntroducerOption {
	id: string;
	name: string;
	/** `inactive` members stay pickable — see `applyUpdateGuestProfile`. */
	status: "active" | "inactive";
}

export interface GuestProfile extends GuestProfileFields {
	roster: IntroducerOption[];
}

/**
 * The introducer join, scoped to THIS club as well as to the id.
 * `introduced_by_member_id` is a bare FK to `members`, which the database does
 * not tie to the guest's club; the write path refuses a cross-club id, and
 * every read joins through this so a row written some other way names NOBODY —
 * neither its name nor its id reaches the client. Such a guest loads as "no
 * introducer", which is also why saving them does not fail on an introducer
 * the officer never saw.
 */
function introducerOfClub(clubId: string) {
	return and(
		eq(members.id, guests.introducedByMemberId),
		eq(members.clubId, clubId),
	);
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
			introducedByMemberId: members.id,
		})
		.from(guests)
		.leftJoin(members, introducerOfClub(clubId))
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
export interface GuestProfileRow
	extends GuestIntroducerRow,
		GuestProfileFields {}

/**
 * Every guest's kind, home club and introducer in this club, plus the
 * per-member "brought" counts (#1050) — derived from these same rows by
 * `countBroughtByMember`, so the tally always matches what the page lists.
 * The introducer (id AND name) comes through `introducerOfClub`.
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
			introducedByMemberId: members.id,
			introducedByName: members.name,
		})
		.from(guests)
		.leftJoin(members, introducerOfClub(clubId))
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
 *   in names people who have since lapsed. A guest's OWN converted membership
 *   is refused: nobody brings themselves.
 * - Null clears the introducer. Omitting it clears it too, like the contact
 *   fields on `applyUpdateGuest`.
 *
 * ONE transaction, with the introducer's row read `FOR SHARE`: a member
 * deleted between the check and the UPDATE would otherwise surface as a raw
 * foreign-key violation, SQL and parameters included, in the officer's toast.
 * The share lock makes a concurrent delete wait for this write (the FK then
 * nulls the pointer, which is its job), and a delete that committed first is
 * simply not found, so the refusal is always the message below.
 *
 * LOCK ORDER is member, then guest — the order a member DELETE takes them: it
 * locks the member row, and `introduced_by_member_id`'s ON DELETE SET NULL then
 * updates every guest row pointing at it. Locking the guest first and the
 * member second is the opposite order and deadlocks against that delete
 * (40P01), and a deadlock abort would put the raw driver error back in the
 * toast. So the guest is read WITHOUT a lock, the member is taken FOR SHARE,
 * and the guest row is locked last, by the UPDATE itself. The unlocked read
 * only feeds the existence and self-introduction checks, and the UPDATE
 * re-asserts the club.
 */
export async function applyUpdateGuestProfile(
	input: UpdateGuestProfileInput,
): Promise<{ ok: true }> {
	const homeClub = normalizeHomeClub(input.kind, input.homeClub);
	if (homeClub !== null && homeClub.length > GUEST_TEXT_MAX) {
		throw new Error(HOME_CLUB_TOO_LONG_MESSAGE);
	}
	const introducedByMemberId = input.introducedByMemberId ?? null;

	return db.transaction(async (tx) => {
		const [guest] = await tx
			.select({
				id: guests.id,
				convertedMembershipId: guests.convertedMembershipId,
			})
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1);
		if (!guest) throw new Error("Guest not found in this club.");

		if (introducedByMemberId !== null) {
			if (introducedByMemberId === guest.convertedMembershipId) {
				throw new Error(GUEST_CANNOT_INTRODUCE_SELF_MESSAGE);
			}
			const [introducer] = await tx
				.select({ id: members.id })
				.from(members)
				.where(
					and(
						eq(members.id, introducedByMemberId),
						eq(members.clubId, input.clubId),
					),
				)
				.limit(1)
				.for("share");
			if (!introducer) throw new Error(INTRODUCER_NOT_IN_CLUB_MESSAGE);
		}

		await tx
			.update(guests)
			.set({
				kind: input.kind,
				homeClub,
				introducedByMemberId,
				updatedAt: new Date(),
			})
			.where(and(eq(guests.id, guest.id), eq(guests.clubId, input.clubId)));
		return { ok: true as const };
	});
}
