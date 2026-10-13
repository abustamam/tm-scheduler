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
import { and, asc, desc, eq, inArray, lt, max, ne } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	speechRequests,
} from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	type QueueOrderable,
	type SpeechRequestFields,
	sortSpeechQueue,
} from "#/lib/speech-requests";
import { TBA_SPEECH_TITLE } from "#/lib/speech-title";
import {
	attachSpeechToOpenSlot,
	listOpenSpeakerSlots,
	type OpenSpeakerSlot,
} from "./speeches-logic";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
type Conn = typeof db | Tx;

export const REQUEST_NOT_FOUND_MESSAGE = "That speech request was not found.";
export const NOT_YOUR_REQUEST_MESSAGE =
	"You can only change your own speech requests.";
export const REQUEST_NOT_OPEN_MESSAGE =
	"That request is no longer open: it was already scheduled or withdrawn.";
export const REQUEST_SLOT_WRONG_CLUB_MESSAGE =
	"That speaker slot is not in this club.";

/** Slots the queue's quick-sum reads; same set the speaker rotation counts as "held". */
const HELD_SLOT_STATUSES = ["claimed", "confirmed"] as const;

export type SpeechRequestStatus = "open" | "scheduled" | "withdrawn";

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
	conn: Conn,
	args: { clubId: string; membershipId: string; fields: SpeechRequestFields },
): Promise<SpeechRequestRow> {
	const [member] = await conn
		.select({ id: members.id })
		.from(members)
		.where(
			and(eq(members.id, args.membershipId), eq(members.clubId, args.clubId)),
		)
		.limit(1);
	if (!member) throw new Error("You're not a member of this club.");
	const [row] = await conn
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

/** Edit the requester's own OPEN request. A scheduled or withdrawn one is history. */
export async function updateSpeechRequest(
	conn: Conn,
	args: {
		requestId: string;
		actorMembershipId: string | null;
		fields: SpeechRequestFields;
	},
): Promise<SpeechRequestRow> {
	await loadOwnedRequest(conn, args.requestId, args.actorMembershipId);
	// Ownership is in the WHERE as well as in the check above: the check gives the
	// right sentence, the predicate is what a concurrent withdraw or schedule
	// cannot slip past.
	const [row] = await conn
		.update(speechRequests)
		.set({
			title: args.fields.title,
			path: args.fields.path,
			projectName: args.fields.projectName,
			introduction: args.fields.introduction,
			preferredDates: args.fields.preferredDates,
		})
		.where(
			and(
				eq(speechRequests.id, args.requestId),
				eq(speechRequests.membershipId, args.actorMembershipId as string),
				eq(speechRequests.status, "open"),
			),
		)
		.returning(REQUEST_COLUMNS);
	if (!row) throw new Error(REQUEST_NOT_OPEN_MESSAGE);
	return row;
}

/** Withdraw the requester's own OPEN request. */
export async function withdrawSpeechRequest(
	conn: Conn,
	args: { requestId: string; actorMembershipId: string | null },
): Promise<void> {
	await loadOwnedRequest(conn, args.requestId, args.actorMembershipId);
	const rows = await conn
		.update(speechRequests)
		.set({ status: "withdrawn" })
		.where(
			and(
				eq(speechRequests.id, args.requestId),
				eq(speechRequests.membershipId, args.actorMembershipId as string),
				eq(speechRequests.status, "open"),
			),
		)
		.returning({ id: speechRequests.id });
	if (rows.length === 0) throw new Error(REQUEST_NOT_OPEN_MESSAGE);
}

export interface MySpeechRequest extends SpeechRequestRow {
	/** The meeting a scheduled request landed on, or null (open, or the slot is gone). */
	scheduledFor: Date | null;
	/** The club's zone, for the day `scheduledFor` falls on. */
	timezone: string;
}

/** The member's open and scheduled requests, newest first. Withdrawn ones are not listed. */
export async function listMySpeechRequests(
	conn: Conn,
	args: { clubId: string; membershipId: string },
): Promise<MySpeechRequest[]> {
	const rows = await conn
		.select({
			...REQUEST_COLUMNS,
			scheduledFor: meetings.scheduledAt,
			timezone: clubs.timezone,
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
	return rows;
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
 * Each member's most recent PAST speaker slot (non-cancelled, held), the same
 * definition the speaker rotation uses, so the two lists never disagree about
 * "last spoke".
 */
async function lastSpokeByMember(
	conn: Conn,
	memberIds: string[],
	now: Date,
): Promise<Map<string, Date>> {
	if (memberIds.length === 0) return new Map();
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
 * The club's open requests, ordered for the VPE: the member who has gone longest
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
				eq(speechRequests.status, "open"),
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

/** Open speaker slots a request can be scheduled into (the reschedule targets). */
export async function listSchedulableSlots(
	clubId: string,
): Promise<OpenSpeakerSlot[]> {
	return listOpenSpeakerSlots(db, clubId);
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
		// The request row lock serialises this against a withdraw or an edit.
		const [request] = await tx
			.select({
				...REQUEST_COLUMNS,
				projectId: speechRequests.projectId,
			})
			.from(speechRequests)
			.where(eq(speechRequests.id, args.requestId))
			.for("update");
		if (!request || request.clubId !== args.clubId) {
			throw new Error(REQUEST_NOT_FOUND_MESSAGE);
		}
		if (request.status !== "open") throw new Error(REQUEST_NOT_OPEN_MESSAGE);

		const [slot] = await tx
			.select({ clubId: meetings.clubId, meetingStatus: meetings.status })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, args.slotId))
			.limit(1);
		if (!slot) throw new Error("Speaker slot not found.");
		if (slot.clubId !== request.clubId) {
			throw new Error(REQUEST_SLOT_WRONG_CLUB_MESSAGE);
		}
		// A requested speech is a PLAN: it goes on an upcoming meeting. A cancelled
		// meeting never happened and a completed one is history, so both refuse here
		// (the reschedule path beneath accepts a completed one as a record write).
		assertMeetingAccepts(slot.meetingStatus, "plan");

		const [owner] = await tx
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, request.membershipId))
			.limit(1);
		if (!owner) throw new Error(REQUEST_NOT_FOUND_MESSAGE);

		const [speech] = await tx
			.insert(speeches)
			.values({
				personId: owner.personId,
				// `speeches.title` is NOT NULL; an untitled request becomes the app's
				// own "TBA" stand-in, which every reader already treats as unset.
				title: request.title ?? TBA_SPEECH_TITLE,
				introduction: request.introduction,
				pathwayPath: request.path,
				projectName: request.projectName,
				projectId: request.projectId,
			})
			.returning({ id: speeches.id });
		if (!speech) throw new Error("Could not create the speech.");

		await attachSpeechToOpenSlot(tx, {
			speechId: speech.id,
			slotId: args.slotId,
			actorMemberId: args.actorMemberId,
		});

		const updated = await tx
			.update(speechRequests)
			.set({ status: "scheduled", scheduledSlotId: args.slotId })
			.where(
				and(
					eq(speechRequests.id, args.requestId),
					eq(speechRequests.status, "open"),
				),
			)
			.returning({ id: speechRequests.id });
		if (updated.length === 0) throw new Error(REQUEST_NOT_OPEN_MESSAGE);
		return { speechId: speech.id, slotId: args.slotId };
	});
}
