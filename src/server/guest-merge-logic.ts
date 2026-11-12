// Guest merge (#1609): a club admin folds one guest record of the club into
// another. DB logic split out of `guest-merge.ts` (a createServerFn module the
// guard test forbids from exporting db-touching functions).
//
// This is NOT the superadmin Person merge (`mergePeople`): that one re-points
// `guests.person_id` across clubs and leaves both guest rows in place. This one
// removes a guest row, so every row that names it moves first.
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	activityLog,
	guestInvites,
	guests,
	importRefs,
	meetingAttendance,
	meetingAwards,
	meetingBallotGuests,
	meetingCandidateDisqualifications,
	meetingGuestRsvps,
	meetingVotes,
	members,
	people,
	roleSlots,
	slotCoverRequests,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	guestContactWritable,
	unboundGuestOnlyPerson,
} from "./account-link-logic";
import { logActivity } from "./activity";
import {
	forUpdate,
	lockClubForWrite,
	lockPersonsInOrder,
	noKeyUpdate,
} from "./club-write-lock";
import { assertStillClubAdmin, getActiveMembership } from "./guards";
import {
	deleteGuestPersonIfUnreferenced,
	GUEST_NOT_IN_CLUB_MESSAGE,
	RECORD_CHANGED_MESSAGE,
} from "./guests-logic";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export const GUEST_MERGE_SAME_MESSAGE = "Pick two different guests to merge.";
export const GUEST_MERGE_CONVERTED_MESSAGE =
	"Undo or finish the conversion first.";
export const GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE =
	"These two guests are different people in the system. Ask a site admin to merge the people first.";
export const GUEST_MERGE_PERSON_LINKED_MESSAGE =
	"The guest to fold in has a speech or enrolment recorded against their person record, so it cannot be merged here. Ask a site admin.";

/**
 * Every table whose rows name a guest, with the column(s) that do. The guard
 * test (`guest-merge-authz.guard.test.ts`) re-derives the list from `schema.ts`
 * and fails when a guest-referencing column is missing here, so a new table
 * cannot be forgotten.
 */
export const GUEST_MERGE_TABLES = [
	"guest_invites",
	"role_slots",
	"slot_cover_requests",
	"meeting_guest_rsvps",
	"meeting_attendance",
	"table_topics_speakers",
	"meeting_awards",
	"meeting_votes",
	"meeting_ballot_guests",
	"meeting_candidate_disqualifications",
	"speeches",
	"import_refs",
] as const;
export type GuestMergeTable = (typeof GUEST_MERGE_TABLES)[number];

export interface MergeGuestsInput {
	clubId: string;
	keepGuestId: string;
	absorbGuestId: string;
	/** The signed-in user; the admin standing is re-asked under the locks. */
	actorUserId: string;
}

export interface MergeGuestsPreview {
	moved: Record<string, number>;
	droppedAsDuplicate: Record<string, number>;
	absorbedPersonDeleted: boolean;
	refusal: string | null;
}

type Outcome = MergeGuestsPreview & { actorMemberId?: string | null };

const emptyCounts = (): Record<string, number> =>
	Object.fromEntries(GUEST_MERGE_TABLES.map((t) => [t, 0]));

const refused = (refusal: string): Outcome => ({
	moved: emptyCounts(),
	droppedAsDuplicate: emptyCounts(),
	absorbedPersonDeleted: false,
	refusal,
});

async function readGuestForUpdate(tx: Tx, clubId: string, id: string) {
	const [row] = await tx
		.select({
			id: guests.id,
			personId: guests.personId,
			stage: guests.stage,
			convertedMembershipId: guests.convertedMembershipId,
			preferredName: guests.preferredName,
			homeClub: guests.homeClub,
			introducedByMemberId: guests.introducedByMemberId,
			bookEmail: guests.bookEmail,
		})
		.from(guests)
		.where(and(eq(guests.id, id), eq(guests.clubId, clubId)))
		.limit(1)
		.for("update");
	return row;
}

/**
 * Take, BEFORE any guest row, the rows a guest-deleting path will re-point or
 * delete that a writer locks first and the guest second (#1611): the guest's
 * slots (the speech-detail save takes the meeting's slot-edit lock, then the
 * slot `FOR UPDATE`, then key-shares the guest through the speech insert) and
 * the votes naming it (an anonymous re-vote locks its own vote row, then
 * key-shares the candidate). Holding a guest `FOR UPDATE` and then asking for
 * those rows was the other end of a 40P01 cycle. Order: slots, then votes, each
 * in id order.
 *
 * Slots are `FOR NO KEY UPDATE`, not `FOR UPDATE`: `role_slots` is the target
 * of foreign keys (`evaluates_slot_id` is a self-FK), and setting one key-shares
 * the target slot, which `FOR UPDATE` would block (an evaluator move holds the
 * evaluator slot and key-shares the speaker slot: a new cycle). It still
 * conflicts with the speech save's `FOR UPDATE` on the slot, which is the edge
 * #1611 needs. Votes are `FOR UPDATE`: the delete cascades them away.
 *
 * The meeting's slot-edit lock is NOT taken: the slot row alone is what the
 * writer holds when it asks for the guest, and an extra lock would only add a
 * way to form a cycle.
 *
 * Narrow window, stated honestly: the scan sees committed rows only. A row
 * that starts naming this guest between the scan and the guest lock (a slot
 * just assigned to it, a vote just cast for it) is not pre-locked, so a writer
 * holding such a row and then key-sharing the guest can still meet the guest
 * lock first. That is a much smaller window than before, not a closed one.
 */
export async function lockRowsNamingGuest(tx: Tx, guestId: string) {
	await tx
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.where(eq(roleSlots.assignedGuestId, guestId))
		.orderBy(roleSlots.id)
		.for("no key update");
	await tx
		.select({ id: meetingVotes.id })
		.from(meetingVotes)
		.where(
			or(
				eq(meetingVotes.candidateGuestId, guestId),
				eq(meetingVotes.voterGuestId, guestId),
			),
		)
		.orderBy(meetingVotes.id)
		.for("update");
}

class PreviewRollback extends Error {
	constructor(readonly outcome: Outcome) {
		super("preview rollback");
	}
}

/**
 * Merge `absorbGuestId` into `keepGuestId`. Irreversible; refusals throw. With
 * `dryRun` it runs the same body in a transaction that always rolls back and
 * returns what it would have done (`previewMergeGuests`), so the preview's
 * numbers cannot differ from the apply's. The apply recomputes under its own
 * locks and never trusts a preview.
 */
export async function applyMergeGuests(
	input: MergeGuestsInput,
	opts: { dryRun?: boolean } = {},
): Promise<MergeGuestsPreview> {
	// Lock order (ADR-0031): the club write lock, both Persons in id order, the
	// absorbed guest's slots and votes (`lockRowsNamingAbsorbed`, #1611),
	// then both guest rows `FOR UPDATE` in id order. Every writer that locks a
	// slot or a vote row and then key-shares a guest therefore meets the merge
	// at the same first row, never the guest. The kept guest's own first ballot
	// or check-in (#1623) is the opposite shape: its INSERT ... ON CONFLICT
	// writes a unique-index entry before its FK check key-shares the guest, and
	// this merge's re-point of the absorbed guest's row collides with that
	// entry. No row of ours can be pre-locked against it, so the WRITER takes
	// the guest `FOR KEY SHARE` before its INSERT (`castVote`, `addGuestPresent`):
	// it then waits on the guest lock holding nothing, or holds the key share
	// and makes the merge wait for it. The delete path re-points nothing onto
	// another guest, so it needs no such writer-side change. The row
	// locks also matter beyond ordering: every foreign-key INSERT naming a guest
	// (a public RSVP, a ballot join) key-shares its row, so a writer racing the
	// merge waits instead of inserting a row that names the deleted guest.
	const run = async (tx: Tx): Promise<Outcome> => {
		const { clubId, keepGuestId, absorbGuestId } = input;
		if (keepGuestId === absorbGuestId) return refused(GUEST_MERGE_SAME_MESSAGE);

		await lockClubForWrite(tx, clubId);
		// Admin standing and the archive gate, asked again INSIDE the lock: the
		// server fn's check ran before a wait that may have been long.
		await assertStillClubAdmin(tx, input.actorUserId, clubId);

		const peeks = await tx
			.select({ id: guests.id, personId: guests.personId })
			.from(guests)
			.where(
				and(
					eq(guests.clubId, clubId),
					inArray(guests.id, [keepGuestId, absorbGuestId]),
				),
			);
		const peekKeep = peeks.find((g) => g.id === keepGuestId);
		const peekAbsorb = peeks.find((g) => g.id === absorbGuestId);
		if (!peekKeep || !peekAbsorb) return refused(GUEST_NOT_IN_CLUB_MESSAGE);

		// The absorbed Person MAY be deleted, so it is locked as a candidate unless
		// it holds a membership (whose speaker claims must not be blocked by a
		// `FOR UPDATE`); `deleteGuestPersonIfUnreferenced` takes the strong lock
		// itself once the Person is a candidate.
		const [absorbedHolds] = await tx
			.select({ id: members.id })
			.from(members)
			.where(eq(members.personId, peekAbsorb.personId))
			.limit(1);
		await lockPersonsInOrder(tx, [
			...noKeyUpdate(peekKeep.personId),
			...(absorbedHolds
				? noKeyUpdate(peekAbsorb.personId)
				: forUpdate(peekAbsorb.personId)),
		]);

		await lockRowsNamingGuest(tx, absorbGuestId);

		const ordered = [keepGuestId, absorbGuestId].sort();
		const rows = new Map<
			string,
			Awaited<ReturnType<typeof readGuestForUpdate>>
		>();
		for (const id of ordered)
			rows.set(id, await readGuestForUpdate(tx, clubId, id));
		const keep = rows.get(keepGuestId);
		const absorb = rows.get(absorbGuestId);
		if (!keep || !absorb) return refused(GUEST_NOT_IN_CLUB_MESSAGE);
		if (
			keep.personId !== peekKeep.personId ||
			absorb.personId !== peekAbsorb.personId
		) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		for (const g of [keep, absorb]) {
			if (g.stage === "joined" || g.convertedMembershipId) {
				return refused(GUEST_MERGE_CONVERTED_MESSAGE);
			}
		}

		const samePerson = keep.personId === absorb.personId;
		let absorbedContact: { email: string | null; phone: string | null } | null =
			null;
		if (!samePerson) {
			// The absorbed Person goes with its only guest row, so it must be held by
			// nothing else: no sign-in, no membership, no other guest row in any club.
			// (A speech or enrolment on it is caught by the delete below.)
			const [guestOnly] = await tx
				.select({ email: people.email, phone: people.phone })
				.from(people)
				.where(and(eq(people.id, absorb.personId), unboundGuestOnlyPerson()))
				.limit(1);
			const [otherRow] = await tx
				.select({ id: guests.id })
				.from(guests)
				.where(
					and(eq(guests.personId, absorb.personId), ne(guests.id, absorb.id)),
				)
				.limit(1);
			if (!guestOnly || otherRow) {
				return refused(GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE);
			}
			absorbedContact = guestOnly;
		}

		const moved = emptyCounts();
		const dropped = emptyCounts();
		const K = keepGuestId;
		const A = absorbGuestId;

		// guest_invites (guest, meeting): the keeper's row wins.
		dropped.guest_invites = (
			await tx
				.delete(guestInvites)
				.where(
					and(
						eq(guestInvites.guestId, A),
						sql`exists (select 1 from guest_invites k where k.guest_id = ${K} and k.meeting_id = ${guestInvites.meetingId})`,
					),
				)
				.returning({ id: guestInvites.id })
		).length;
		moved.guest_invites = (
			await tx
				.update(guestInvites)
				.set({ guestId: K })
				.where(eq(guestInvites.guestId, A))
				.returning({ id: guestInvites.id })
		).length;

		// meeting_guest_rsvps (meeting, guest).
		dropped.meeting_guest_rsvps = (
			await tx
				.delete(meetingGuestRsvps)
				.where(
					and(
						eq(meetingGuestRsvps.guestId, A),
						sql`exists (select 1 from meeting_guest_rsvps k where k.guest_id = ${K} and k.meeting_id = ${meetingGuestRsvps.meetingId})`,
					),
				)
				.returning({ id: meetingGuestRsvps.id })
		).length;
		moved.meeting_guest_rsvps = (
			await tx
				.update(meetingGuestRsvps)
				.set({ guestId: K })
				.where(eq(meetingGuestRsvps.guestId, A))
				.returning({ id: meetingGuestRsvps.id })
		).length;

		// meeting_attendance (meeting, guest). An import ref naming a dropped
		// attendance row is re-pointed to the keeper's row for that meeting first, so
		// a re-import does not recreate the row the merge dropped.
		await tx.execute(sql`
		UPDATE import_refs ir
		SET target_id = k.id
		FROM meeting_attendance a, meeting_attendance k
		WHERE ir.club_id = ${clubId}
			AND ir.kind = 'attendance'
			AND ir.target_id = a.id
			AND a.guest_id = ${A}
			AND k.guest_id = ${K}
			AND k.meeting_id = a.meeting_id`);
		dropped.meeting_attendance = (
			await tx
				.delete(meetingAttendance)
				.where(
					and(
						eq(meetingAttendance.guestId, A),
						sql`exists (select 1 from meeting_attendance k where k.guest_id = ${K} and k.meeting_id = ${meetingAttendance.meetingId})`,
					),
				)
				.returning({ id: meetingAttendance.id })
		).length;
		moved.meeting_attendance = (
			await tx
				.update(meetingAttendance)
				.set({ guestId: K })
				.where(eq(meetingAttendance.guestId, A))
				.returning({ id: meetingAttendance.id })
		).length;

		// meeting_votes: the voter collision key is (session, voter_guest); the
		// keeper's ballot wins. A vote FOR the absorbed guest becomes one for the
		// keeper (no unique key on the candidate columns).
		dropped.meeting_votes = (
			await tx
				.delete(meetingVotes)
				.where(
					and(
						eq(meetingVotes.voterGuestId, A),
						sql`exists (select 1 from meeting_votes k where k.voter_guest_id = ${K} and k.session_id = ${meetingVotes.sessionId})`,
					),
				)
				.returning({ id: meetingVotes.id })
		).length;
		const voterMoved = await tx
			.update(meetingVotes)
			.set({ voterGuestId: K })
			.where(eq(meetingVotes.voterGuestId, A))
			.returning({ id: meetingVotes.id });
		const candidateMoved = await tx
			.update(meetingVotes)
			.set({ candidateGuestId: K })
			.where(eq(meetingVotes.candidateGuestId, A))
			.returning({ id: meetingVotes.id });
		// A vote where the absorbed guest is both voter and candidate is one row.
		moved.meeting_votes = new Set([
			...voterMoved.map((v) => v.id),
			...candidateMoved.map((v) => v.id),
		]).size;

		// meeting_ballot_guests PK (meeting, guest).
		dropped.meeting_ballot_guests = (
			await tx
				.delete(meetingBallotGuests)
				.where(
					and(
						eq(meetingBallotGuests.guestId, A),
						sql`exists (select 1 from meeting_ballot_guests k where k.guest_id = ${K} and k.meeting_id = ${meetingBallotGuests.meetingId})`,
					),
				)
				.returning({ id: meetingBallotGuests.meetingId })
		).length;
		moved.meeting_ballot_guests = (
			await tx
				.update(meetingBallotGuests)
				.set({ guestId: K })
				.where(eq(meetingBallotGuests.guestId, A))
				.returning({ id: meetingBallotGuests.meetingId })
		).length;

		// meeting_candidate_disqualifications (meeting, category, candidate guest).
		// Its FK to `guests` CASCADES, so a row not moved here is silently deleted
		// with the guest row.
		dropped.meeting_candidate_disqualifications = (
			await tx
				.delete(meetingCandidateDisqualifications)
				.where(
					and(
						eq(meetingCandidateDisqualifications.candidateGuestId, A),
						sql`exists (select 1 from meeting_candidate_disqualifications k where k.candidate_guest_id = ${K} and k.meeting_id = ${meetingCandidateDisqualifications.meetingId} and k.category = ${meetingCandidateDisqualifications.category})`,
					),
				)
				.returning({ id: meetingCandidateDisqualifications.id })
		).length;
		moved.meeting_candidate_disqualifications = (
			await tx
				.update(meetingCandidateDisqualifications)
				.set({ candidateGuestId: K })
				.where(eq(meetingCandidateDisqualifications.candidateGuestId, A))
				.returning({ id: meetingCandidateDisqualifications.id })
		).length;

		// Tables with no unique key on the guest: plain re-points.
		moved.role_slots = (
			await tx
				.update(roleSlots)
				.set({ assignedGuestId: K })
				.where(eq(roleSlots.assignedGuestId, A))
				.returning({ id: roleSlots.id })
		).length;
		moved.slot_cover_requests = (
			await tx
				.update(slotCoverRequests)
				.set({ coveredGuestId: K })
				.where(eq(slotCoverRequests.coveredGuestId, A))
				.returning({ id: slotCoverRequests.id })
		).length;
		moved.table_topics_speakers = (
			await tx
				.update(tableTopicsSpeakers)
				.set({ guestId: K })
				.where(eq(tableTopicsSpeakers.guestId, A))
				.returning({ id: tableTopicsSpeakers.id })
		).length;
		moved.meeting_awards = (
			await tx
				.update(meetingAwards)
				.set({ guestId: K })
				.where(eq(meetingAwards.guestId, A))
				.returning({ id: meetingAwards.id })
		).length;
		moved.speeches = (
			await tx
				.update(speeches)
				.set({ guestId: K })
				.where(eq(speeches.guestId, A))
				.returning({ id: speeches.id })
		).length;
		// import_refs: no FK, so nothing cascades, but a re-import would match the
		// absorbed source id to a row that no longer exists.
		moved.import_refs = (
			await tx
				.update(importRefs)
				.set({ targetId: K })
				.where(
					and(
						eq(importRefs.clubId, clubId),
						eq(importRefs.kind, "guest"),
						eq(importRefs.targetId, A),
					),
				)
				.returning({ id: importRefs.sourceId })
		).length;

		// The keeper keeps its own profile; a blank takes the absorbed value.
		const fill: Partial<typeof guests.$inferInsert> = {};
		if (keep.preferredName === null && absorb.preferredName !== null)
			fill.preferredName = absorb.preferredName;
		if (keep.homeClub === null && absorb.homeClub !== null)
			fill.homeClub = absorb.homeClub;
		if (
			keep.introducedByMemberId === null &&
			absorb.introducedByMemberId !== null
		)
			fill.introducedByMemberId = absorb.introducedByMemberId;
		if (keep.bookEmail === null && absorb.bookEmail !== null)
			fill.bookEmail = absorb.bookEmail;
		if (Object.keys(fill).length > 0) {
			await tx
				.update(guests)
				.set({ ...fill, updatedAt: new Date() })
				.where(eq(guests.id, K));
		}

		// A link may have stashed this guest's contact on an activity row; it must
		// not outlive the guest (the same clean-up `applyDeleteGuest` does).
		await tx
			.update(activityLog)
			.set({ detail: sql`${activityLog.detail} - 'guestContact'` })
			.where(
				and(
					eq(activityLog.clubId, clubId),
					eq(activityLog.action, "member_merge"),
					sql`${activityLog.detail}->>'fromGuestId' = ${A}`,
					sql`${activityLog.detail} ? 'guestContact'`,
				),
			);
		await tx.delete(guests).where(eq(guests.id, A));

		let absorbedPersonDeleted = false;
		if (!samePerson && absorbedContact) {
			// Nothing may still name the absorbed Person. A Person that survives here
			// is a merge that did not do what it says: the caller rolls it back.
			if (!(await deleteGuestPersonIfUnreferenced(tx, absorb.personId))) {
				return refused(GUEST_MERGE_PERSON_LINKED_MESSAGE);
			}
			absorbedPersonDeleted = true;
			// Fill the keeper Person's BLANKS from the absorbed contact, after the
			// absorbed Person is gone (so the address is not on two rows at once).
			// Each statement carries the officer-edit predicate in its own WHERE
			// (`guestContactWritable`): a keeper Person that is a member's, or signed
			// in, is left exactly as it is.
			if (absorbedContact.email) {
				await tx
					.update(people)
					.set({ email: absorbedContact.email })
					.where(
						and(
							eq(people.id, keep.personId),
							guestContactWritable(clubId),
							or(isNull(people.email), eq(people.email, "")),
						),
					);
			}
			if (absorbedContact.phone) {
				await tx
					.update(people)
					.set({ phone: absorbedContact.phone })
					.where(
						and(
							eq(people.id, keep.personId),
							guestContactWritable(clubId),
							or(isNull(people.phone), eq(people.phone, "")),
						),
					);
			}
		}

		const actor = await getActiveMembership(input.actorUserId, clubId, tx);
		// No name, email or phone: the feed is readable by every member.
		await logActivity(tx, {
			clubId,
			actorMemberId: actor?.id ?? null,
			action: "guest_merge",
			targetType: "club",
			detail: { keptGuestId: K, absorbedGuestId: A },
		});

		return {
			moved,
			droppedAsDuplicate: dropped,
			absorbedPersonDeleted,
			refusal: null,
		};
	};
	const strip = (o: Outcome): MergeGuestsPreview => ({
		moved: o.moved,
		droppedAsDuplicate: o.droppedAsDuplicate,
		absorbedPersonDeleted: o.absorbedPersonDeleted,
		refusal: o.refusal,
	});
	if (opts.dryRun) {
		try {
			await db.transaction(async (tx) => {
				throw new PreviewRollback(await run(tx));
			});
		} catch (err) {
			if (err instanceof PreviewRollback) return strip(err.outcome);
			throw err;
		}
		throw new Error("unreachable");
	}
	return db.transaction(async (tx) => {
		const outcome = await run(tx);
		// Throwing rolls back everything the body wrote before it refused.
		if (outcome.refusal) throw new Error(outcome.refusal);
		return strip(outcome);
	});
}

/** What the merge would move, drop and refuse; writes nothing. */
export async function previewMergeGuests(
	input: MergeGuestsInput,
): Promise<MergeGuestsPreview> {
	return applyMergeGuests(input, { dryRun: true });
}

/** The picker's rows: this club's other guests, name and kind/stage only. */
export interface MergeGuestCandidate {
	id: string;
	name: string;
	kind: string;
	stage: string;
}

export async function listMergeGuestCandidates(input: {
	clubId: string;
	guestId: string;
}): Promise<MergeGuestCandidate[]> {
	return db
		.select({
			id: guests.id,
			name: guests.name,
			kind: guests.kind,
			stage: guests.stage,
		})
		.from(guests)
		.where(
			and(
				eq(guests.clubId, input.clubId),
				ne(guests.id, input.guestId),
				// A joined or converted guest is refused by the merge anyway.
				ne(guests.stage, "joined"),
				isNull(guests.convertedMembershipId),
			),
		)
		.orderBy(guests.name, guests.id)
		.limit(500);
}
