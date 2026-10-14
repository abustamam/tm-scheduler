// Speech-request queue DB logic (#1052, epic #1054), split out from
// `speech-requests.ts` (a createServerFn module the server-modules guard forbids
// from exporting db-touching functions).
//
// A request is what a member typed: a title, a path and project, an introduction
// and up to three preferred dates. It is NOT a speech. `Schedule` is the only
// place one becomes a `speeches` row, and it does so inside the same transaction
// that fills the slot, so a refused slot leaves the request open and leaves no
// orphan speech behind.
//
// Who may do what is decided here and again at the server fns:
//   - create / edit / withdraw: the requester only (`membership_id` must be the
//     actor's own). A club admin is NOT the owner; an officer cannot edit a
//     member's words, only schedule them.
//   - queue + schedule: a club admin (the VPE is one; ADR-0008).
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	lt,
	max,
	ne,
	notExists,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	type speechRequestStatusEnum,
	speechRequests,
} from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	type QueueOrderable,
	type SpeechRequestFields,
	sortSpeechQueue,
} from "#/lib/speech-requests";
import { TBA_SPEECH_TITLE } from "#/lib/speech-title";
import { lockMeetingForSlotEdit } from "./meeting-slot-lock";
import { lockMembershipsAgainstMerge } from "./membership-merge-lock";
import { HELD_SLOT_STATUSES } from "./reporting-logic";
import { attachSpeechToOpenSlot } from "./speeches-logic";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
type Conn = typeof db | Tx;

export const REQUEST_NOT_FOUND_MESSAGE = "That speech request was not found.";
export const NOT_YOUR_REQUEST_MESSAGE =
	"You can only change your own speech requests.";
export const REQUEST_NOT_OPEN_MESSAGE =
	"That request is no longer open: it was already scheduled or withdrawn.";
export const REQUEST_SLOT_WRONG_CLUB_MESSAGE =
	"That speaker slot is not in this club.";
export const REQUEST_MEETING_PAST_MESSAGE =
	"That meeting has already started or passed; pick an upcoming meeting.";

export type SpeechRequestStatus =
	(typeof speechRequestStatusEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// "Live": the ONE definition of a scheduled request that still holds a slot
// ---------------------------------------------------------------------------
//
// `status = 'scheduled'` is a write made once, at Schedule. Nothing in the slot
// code (release, reassign, delete, a meeting cancel) writes back to
// `speech_requests`, and the FK's `on delete set null` only clears the slot id.
// So the stored status goes stale, and the request is DERIVED instead: a
// scheduled request is live only while its slot is still held by its own
// membership, on a meeting that was not cancelled. A scheduled request that is
// not live behaves as OPEN everywhere (queue, /me, edit, withdraw, Schedule).
//
// Written as plain SQL text with a fixed alias for the inner tables and the
// literal `"speech_requests"` as the outer reference: a drizzle column
// interpolated into a hand-written subquery drops its table qualifier on a
// single-table statement (an UPDATE), and the unqualified `status` / `id` would
// then bind to the INNER tables. The literal qualifier is valid in a SELECT
// (the table is not aliased) and in an UPDATE alike.
const HELD_STATUSES_SQL = sql.raw(
	HELD_SLOT_STATUSES.map((status) => `'${status}'`).join(", "),
);
const SLOT_STILL_HELD = sql`exists (
	select 1 from role_slots rs
	inner join meetings mt on mt.id = rs.meeting_id
	where rs.id = "speech_requests"."scheduled_slot_id"
		and rs.assigned_member_id = "speech_requests"."membership_id"
		and rs.status in (${HELD_STATUSES_SQL})
		and mt.status <> 'cancelled'
)`;

/** SQL: the request is scheduled AND its slot is still held by its member. */
export const speechRequestIsLive = sql<boolean>`("speech_requests"."status" = 'scheduled' and ${SLOT_STILL_HELD})`;

/** SQL: the request can be queued, edited, withdrawn or scheduled: open, or scheduled but no longer live. */
export const speechRequestIsOpen = sql<boolean>`("speech_requests"."status" = 'open' or ("speech_requests"."status" = 'scheduled' and not ${SLOT_STILL_HELD}))`;

export interface SpeechRequestRow {
	id: string;
	clubId: string;
	membershipId: string;
	title: string | null;
	path: string | null;
	projectName: string | null;
	introduction: string | null;
	preferredDates: string[];
	status: SpeechRequestStatus;
	scheduledSlotId: string | null;
	createdAt: Date;
}

const REQUEST_COLUMNS = {
	id: speechRequests.id,
	clubId: speechRequests.clubId,
	membershipId: speechRequests.membershipId,
	title: speechRequests.title,
	path: speechRequests.path,
	projectName: speechRequests.projectName,
	introduction: speechRequests.introduction,
	preferredDates: speechRequests.preferredDates,
	status: speechRequests.status,
	scheduledSlotId: speechRequests.scheduledSlotId,
	createdAt: speechRequests.createdAt,
} as const;

/** The club a request belongs to, or null when there is no such request. The server fns gate on it. */
export async function getSpeechRequestClubId(
	requestId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ clubId: speechRequests.clubId })
		.from(speechRequests)
		.where(eq(speechRequests.id, requestId))
		.limit(1);
	return row?.clubId ?? null;
}

// ---------------------------------------------------------------------------
// The member's own requests
// ---------------------------------------------------------------------------

/** Create a request for `membershipId`, which must be a membership of `clubId`. */
export async function createSpeechRequest(
	conn: typeof db,
	args: { clubId: string; membershipId: string; fields: SpeechRequestFields },
): Promise<SpeechRequestRow> {
	return conn.transaction(async (tx) => {
		// The membership merge lock (#1035), SHARED, before anything else. A merge
		// re-points `speech_requests.membership_id` and then DELETEs the absorbed
		// membership, whose FK is ON DELETE CASCADE: an insert that lands between
		// the two is not re-pointed and is deleted with it, so the member's ask
		// vanishes after a success. With the lock the insert either finishes
		// before the merge (and is re-pointed) or finds the membership gone and
		// is refused with CLUB_BUSY_MESSAGE. See `membership-merge-lock.ts`.
		await lockMembershipsAgainstMerge(tx, [args.membershipId]);
		const [member] = await tx
			.select({ id: members.id })
			.from(members)
			.where(
				and(eq(members.id, args.membershipId), eq(members.clubId, args.clubId)),
			)
			.limit(1);
		if (!member) throw new Error("You're not a member of this club.");
		const [row] = await tx
			.insert(speechRequests)
			.values({
				clubId: args.clubId,
				membershipId: args.membershipId,
				title: args.fields.title,
				path: args.fields.path,
				projectName: args.fields.projectName,
				introduction: args.fields.introduction,
				preferredDates: args.fields.preferredDates,
			})
			.returning(REQUEST_COLUMNS);
		if (!row) throw new Error("Could not save the request.");
		return row;
	});
}

/** Run `fn` in a transaction on `conn`, which is the pool or an open transaction (a savepoint). */
function transactionOn<T>(conn: Conn, fn: (tx: Tx) => Promise<T>): Promise<T> {
	return (conn as typeof db).transaction(fn);
}

/**
 * Take the request's row lock (`for update`) for the rest of the transaction.
 * Every write that decides on `speechRequestIsOpen` / `speechRequestIsLive` does
 * this FIRST and decides in a LATER statement; see `updateSpeechRequest`.
 */
async function lockRequestRow(tx: Tx, requestId: string): Promise<void> {
	const [locked] = await tx
		.select({ id: speechRequests.id })
		.from(speechRequests)
		.where(eq(speechRequests.id, requestId))
		.for("update");
	if (!locked) throw new Error(REQUEST_NOT_FOUND_MESSAGE);
}

/**
 * The request, once the actor is shown to own it. `actorMembershipId` is null for
 * a memberless impersonation session, which owns nothing.
 */
async function loadOwnedRequest(
	conn: Conn,
	requestId: string,
	actorMembershipId: string | null,
): Promise<SpeechRequestRow> {
	const [row] = await conn
		.select(REQUEST_COLUMNS)
		.from(speechRequests)
		.where(eq(speechRequests.id, requestId))
		.limit(1);
	if (!row) throw new Error(REQUEST_NOT_FOUND_MESSAGE);
	if (actorMembershipId === null || row.membershipId !== actorMembershipId) {
		throw new Error(NOT_YOUR_REQUEST_MESSAGE);
	}
	return row;
}

/**
 * Edit the requester's own OPEN request (open, or scheduled but no longer live,
 * which is edited back to open). A live scheduled or a withdrawn one is history.
 */
export async function updateSpeechRequest(
	conn: Conn,
	args: {
		requestId: string;
		actorMembershipId: string | null;
		fields: SpeechRequestFields;
	},
): Promise<SpeechRequestRow> {
	const owned = await loadOwnedRequest(
		conn,
		args.requestId,
		args.actorMembershipId,
	);
	// Lock the row, THEN write, in one transaction. A single UPDATE whose WHERE
	// holds `speechRequestIsOpen` (a subquery over role_slots) that waits on the
	// row lock re-checks the WHERE against the NEW row version but evaluates the
	// subquery with the snapshot it took BEFORE the wait. A VPE re-scheduling a
	// released request, committing while this edit waits, fills a new slot the old
	// snapshot cannot see: the request reads "no longer live", the edit resets it
	// to open with no slot while the slot holds the speech. Once the lock is ours
	// the UPDATE does not wait, and a new statement takes a new snapshot.
	// Ownership stays in the WHERE as well as in the check above: the check gives
	// the right sentence, the predicate is what a concurrent withdraw, schedule or
	// merge cannot slip past.
	return transactionOn(conn, async (tx) => {
		await lockRequestRow(tx, args.requestId);
		const [row] = await tx
			.update(speechRequests)
			.set({
				title: args.fields.title,
				path: args.fields.path,
				projectName: args.fields.projectName,
				introduction: args.fields.introduction,
				preferredDates: args.fields.preferredDates,
				// A scheduled request whose slot is gone is open again; say so on the row.
				status: "open",
				scheduledSlotId: null,
			})
			.where(
				and(
					eq(speechRequests.id, args.requestId),
					eq(speechRequests.membershipId, owned.membershipId),
					speechRequestIsOpen,
				),
			)
			.returning(REQUEST_COLUMNS);
		if (!row) throw new Error(REQUEST_NOT_OPEN_MESSAGE);
		return row;
	});
}

/** Withdraw the requester's own OPEN request (including a scheduled one whose slot is gone). */
export async function withdrawSpeechRequest(
	conn: Conn,
	args: { requestId: string; actorMembershipId: string | null },
): Promise<void> {
	const owned = await loadOwnedRequest(
		conn,
		args.requestId,
		args.actorMembershipId,
	);
	// Lock first, as `updateSpeechRequest` does and for the same reason.
	await transactionOn(conn, async (tx) => {
		await lockRequestRow(tx, args.requestId);
		const rows = await tx
			.update(speechRequests)
			.set({ status: "withdrawn" })
			.where(
				and(
					eq(speechRequests.id, args.requestId),
					eq(speechRequests.membershipId, owned.membershipId),
					speechRequestIsOpen,
				),
			)
			.returning({ id: speechRequests.id });
		if (rows.length === 0) throw new Error(REQUEST_NOT_OPEN_MESSAGE);
	});
}

export interface MySpeechRequest extends SpeechRequestRow {
	/** The meeting a scheduled request landed on, or null (open, or the slot is gone). */
	scheduledFor: Date | null;
	/** It was scheduled and the slot is no longer its member's (released, reassigned, deleted, cancelled): it is open again. */
	backInQueue: boolean;
	/** The club's zone, for the day `scheduledFor` falls on. */
	timezone: string;
}

/**
 * The member's open and scheduled requests, newest first. Withdrawn ones are not
 * listed. A scheduled request that is no longer live is returned as OPEN, with
 * `backInQueue` set, so the page can say so.
 */
export async function listMySpeechRequests(
	conn: Conn,
	args: { clubId: string; membershipId: string },
): Promise<MySpeechRequest[]> {
	const rows = await conn
		.select({
			...REQUEST_COLUMNS,
			scheduledFor: meetings.scheduledAt,
			timezone: clubs.timezone,
			live: speechRequestIsLive,
		})
		.from(speechRequests)
		.innerJoin(clubs, eq(clubs.id, speechRequests.clubId))
		.leftJoin(roleSlots, eq(roleSlots.id, speechRequests.scheduledSlotId))
		.leftJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(speechRequests.clubId, args.clubId),
				eq(speechRequests.membershipId, args.membershipId),
				inArray(speechRequests.status, ["open", "scheduled"]),
			),
		)
		.orderBy(desc(speechRequests.createdAt), asc(speechRequests.id));
	return rows.map(({ live, ...row }) => {
		const backInQueue = row.status === "scheduled" && !live;
		if (!backInQueue) return { ...row, backInQueue: false };
		return {
			...row,
			status: "open" as const,
			scheduledSlotId: null,
			scheduledFor: null,
			backInQueue: true,
		};
	});
}

// ---------------------------------------------------------------------------
// The VPE's queue
// ---------------------------------------------------------------------------

export interface SpeechQueueRow extends QueueOrderable {
	id: string;
	memberId: string;
	memberName: string;
	title: string | null;
	path: string | null;
	projectName: string | null;
	introduction: string | null;
	preferredDates: string[];
	lastSpokeAt: Date | null;
	createdAt: Date;
}

/**
 * Each member's most recent PAST speaker slot (non-cancelled meeting, held
 * status), as the date of that meeting. It is a second copy of the join
 * `loadSpeakerRotation` aggregates (`HELD_SLOT_STATUSES` is the one shared
 * constant); `speech-requests.integration.test.ts` runs both on one fixture and
 * asserts they agree, which is what keeps the two from drifting.
 */
async function lastSpokeByMember(
	conn: Conn,
	memberIds: string[],
	now: Date,
): Promise<Map<string, Date>> {
	const rows = await conn
		.select({
			memberId: roleSlots.assignedMemberId,
			lastSpokeAt: max(meetings.scheduledAt),
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			and(
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				eq(roleDefinitions.isSpeakerRole, true),
			),
		)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.where(
			and(
				inArray(roleSlots.assignedMemberId, memberIds),
				inArray(roleSlots.status, [...HELD_SLOT_STATUSES]),
			),
		)
		.groupBy(roleSlots.assignedMemberId);
	const out = new Map<string, Date>();
	for (const row of rows) {
		if (row.memberId && row.lastSpokeAt) out.set(row.memberId, row.lastSpokeAt);
	}
	return out;
}

/**
 * The club's open requests (a scheduled one whose slot is gone included), ordered for the VPE: the member who has gone longest
 * since their last speech first (never-spoken before anyone who has), then the
 * oldest request. Only ACTIVE members' requests are listed: Schedule needs an
 * active membership to put the speaker in a slot.
 */
export async function listSpeechRequestQueue(
	conn: Conn,
	clubId: string,
	now: Date = new Date(),
): Promise<SpeechQueueRow[]> {
	const rows = await conn
		.select({
			id: speechRequests.id,
			memberId: members.id,
			memberName: members.name,
			title: speechRequests.title,
			path: speechRequests.path,
			projectName: speechRequests.projectName,
			introduction: speechRequests.introduction,
			preferredDates: speechRequests.preferredDates,
			createdAt: speechRequests.createdAt,
		})
		.from(speechRequests)
		.innerJoin(members, eq(members.id, speechRequests.membershipId))
		.where(
			and(
				eq(speechRequests.clubId, clubId),
				speechRequestIsOpen,
				eq(members.status, "active"),
			),
		)
		.orderBy(asc(speechRequests.createdAt), asc(speechRequests.id));
	const last = await lastSpokeByMember(
		conn,
		[...new Set(rows.map((r) => r.memberId))],
		now,
	);
	return sortSpeechQueue(
		rows.map((r) => ({ ...r, lastSpokeAt: last.get(r.memberId) ?? null })),
	);
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * Put an open request into an open speaker slot: create the Person-owned speech
 * from the request's words, fill the slot with it (through
 * `attachSpeechToOpenSlot`, the reschedule path, so its checks and its race guard
 * apply), and mark the request scheduled with the slot it went to.
 *
 * ONE transaction. A refusal anywhere (a cancelled or completed meeting, a slot
 * taken meanwhile, a speaker who is no longer an active member) rolls the speech
 * back with it and leaves the request open, which is the point: the VPE picks
 * another slot.
 *
 * The caller has proved a club admin. `clubId` is the club that gate was run for;
 * a request or slot of another club is refused here.
 */
export async function scheduleSpeechRequest(
	args: {
		requestId: string;
		slotId: string;
		clubId: string;
		actorMemberId: string | null;
	},
	conn: typeof db = db,
): Promise<{ speechId: string; slotId: string }> {
	return conn.transaction(async (tx) => {
		// The membership merge lock (#1035), SHARED, before the request row or the
		// meeting is locked (#1189, "the merge lock first", see `applyMemberRemove`).
		// A removal of the requester holds the meeting and its DELETE cascades to this
		// request row (`membership_id` is ON DELETE CASCADE), while this locked the
		// request row and then asked for the meeting: 40P01. With the lock the removal
		// and this Schedule never interleave. The membership is read with a plain
		// select, since the lock has to come first; a merge that re-pointed the request
		// before we got here has deleted the old membership, which the lock refuses
		// with CLUB_BUSY_MESSAGE, and one that has not cannot start while we hold it.
		const [asked] = await tx
			.select({
				membershipId: speechRequests.membershipId,
				clubId: speechRequests.clubId,
			})
			.from(speechRequests)
			.where(eq(speechRequests.id, args.requestId));
		if (!asked || asked.clubId !== args.clubId) {
			throw new Error(REQUEST_NOT_FOUND_MESSAGE);
		}
		await lockMembershipsAgainstMerge(tx, [asked.membershipId]);
		// The request row lock serialises this against a withdraw, an edit or
		// another Schedule.
		await lockRequestRow(tx, args.requestId);
		// READ the request in a SECOND statement. A `for update` that waited on a
		// concurrent Schedule returns the row's committed columns, but evaluates
		// every subquery in its select list against the snapshot it took BEFORE the
		// wait, which cannot see the slot that Schedule filled: `live` would read
		// false for a request that is live, and both would schedule it. A new
		// statement takes a new snapshot, after the lock is ours.
		const [request] = await tx
			.select({
				...REQUEST_COLUMNS,
				projectId: speechRequests.projectId,
				speechId: speechRequests.speechId,
				live: speechRequestIsLive,
			})
			.from(speechRequests)
			.where(eq(speechRequests.id, args.requestId));
		if (!request || request.clubId !== args.clubId) {
			throw new Error(REQUEST_NOT_FOUND_MESSAGE);
		}
		// Open, or scheduled into a slot its member no longer holds (released,
		// reassigned, deleted, cancelled): that one is open again and may be
		// scheduled afresh. A LIVE scheduled or a withdrawn request is refused.
		if (
			!(
				request.status === "open" ||
				(request.status === "scheduled" && !request.live)
			)
		) {
			throw new Error(REQUEST_NOT_OPEN_MESSAGE);
		}

		const [located] = await tx
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(eq(roleSlots.id, args.slotId))
			.limit(1);
		if (!located) throw new Error("Speaker slot not found.");
		// The meeting row, locked, BEFORE its status is read: the sibling plan
		// writers do the same (`lockMeetingForSlotEdit`), so a cancel or a complete
		// that lands between this check and the slot write waits for this
		// transaction instead of slipping a speech onto a cancelled meeting. The
		// lock covers the status UPDATE; the attach beneath reads and writes the
		// slot while it is held.
		const slot = await lockMeetingForSlotEdit(tx, located.meetingId);
		if (slot.clubId !== request.clubId) {
			throw new Error(REQUEST_SLOT_WRONG_CLUB_MESSAGE);
		}
		// A requested speech is a PLAN: it goes on an upcoming meeting. A cancelled
		// meeting never happened and a completed one is history, so both refuse here
		// (the reschedule path beneath accepts a completed one as a record write).
		assertMeetingAccepts(slot.status, "plan");
		// And a meeting whose time has passed is history even while its status still
		// reads `scheduled` (nobody has completed it yet). Same instant the
		// Schedule picker lists by (`listOpenSpeakerSlots`: `scheduledAt >= now`).
		if (slot.scheduledAt.getTime() < Date.now()) {
			throw new Error(REQUEST_MEETING_PAST_MESSAGE);
		}

		const [owner] = await tx
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, request.membershipId))
			.limit(1);
		if (!owner) throw new Error(REQUEST_NOT_FOUND_MESSAGE);

		const fields = {
			// `speeches.title` is NOT NULL; an untitled request becomes the app's
			// own "TBA" stand-in, which every reader already treats as unset.
			title: request.title ?? TBA_SPEECH_TITLE,
			introduction: request.introduction,
			pathwayPath: request.path,
			projectName: request.projectName,
			projectId: request.projectId,
		};
		// A re-schedule of a request that was scheduled before REUSES the speech its
		// first Schedule made, when that speech is on no slot: release and reassign
		// leave it unattached, and a second speech would leave the member with two
		// copies of one ask. A speech still on a slot (a cancelled meeting's slot
		// keeps it as history) is left where it is and a new one is made.
		let speechId: string | null = null;
		if (request.speechId) {
			const [reusable] = await tx
				.select({ id: speeches.id })
				.from(speeches)
				.where(
					and(
						eq(speeches.id, request.speechId),
						eq(speeches.personId, owner.personId),
						notExists(
							tx
								.select({ one: sql`1` })
								.from(roleSlots)
								.where(eq(roleSlots.speechId, request.speechId)),
						),
					),
				)
				.for("update");
			if (reusable) {
				await tx
					.update(speeches)
					.set(fields)
					.where(eq(speeches.id, reusable.id));
				speechId = reusable.id;
			}
		}
		if (speechId === null) {
			const [speech] = await tx
				.insert(speeches)
				.values({ personId: owner.personId, ...fields })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Could not create the speech.");
			speechId = speech.id;
		}

		await attachSpeechToOpenSlot(tx, {
			speechId,
			slotId: args.slotId,
			actorMemberId: args.actorMemberId,
		});

		const updated = await tx
			.update(speechRequests)
			.set({ status: "scheduled", scheduledSlotId: args.slotId, speechId })
			// Compare-and-swap on the status read under the row lock, NOT on the
			// "open" predicate: a request being re-scheduled into the very slot it
			// held before is LIVE again once the attach above has filled it, so the
			// open predicate would refuse its own legitimate write.
			.where(
				and(
					eq(speechRequests.id, args.requestId),
					eq(speechRequests.status, request.status),
				),
			)
			.returning({ id: speechRequests.id });
		if (updated.length === 0) throw new Error(REQUEST_NOT_OPEN_MESSAGE);
		return { speechId, slotId: args.slotId };
	});
}
