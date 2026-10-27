// Mentorship (#939, CONTEXT.md "Mentorship"): the db half. Split out from the
// `createServerFn` wrappers in `mentorship.ts` so it is directly
// integration-testable and its `db` import never reaches the client bundle
// (see the header of `members-logic.ts`). Member-to-member pairings inside one
// club, NOT the charter "club mentor" (`club_charter_helpers`), which nothing
// here reads.
//
// Three kinds of access:
//  - ADMIN writes about other people (create, end, change focus). Their
//    callers gate on `requireClubRole(…, ["admin"])`; this file checks every
//    row it touches belongs to that club, that both memberships are ACTIVE,
//    and that mentor ≠ mentee. Each logs a `member_edit` via `logActivity`,
//    so a read-write impersonation leaves `impersonated_by`.
//  - The member's OWN "willing to mentor" flag. The row is resolved FROM THE
//    SESSION (`ownMembershipId`); the input is `.strict()` and names no
//    member, so no request can point it at someone else.
//  - READS. The mentee's and the mentor's own view carry only pairings the
//    caller is a party to; the admin reads carry the club's. READS NEVER
//    WRITE: a read gate admits a read-only impersonation session.
//
// Contact: a party's view carries the OTHER party's email and phone. That is
// the rule the app already applies to club members (`getMemberProfile` and
// `listClubMembers` return every member's contact to any active member of the
// club, behind `requireClubViewAccess`), not a new one.
import {
	and,
	asc,
	countDistinct,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import { members, mentorshipRequests, mentorships, people } from "#/db/schema";
import {
	MENTOR_BIO_MAX,
	MENTORSHIP_FOCUS_OTHER_MAX,
	MENTORSHIP_FOCUSES,
	type MentorCandidate,
	type MentorshipFocus,
	orderMentorCandidates,
} from "#/lib/mentorship";
import { coalesceToE164 } from "#/lib/phone";
import {
	type ContactMethod,
	effectivePreferredContact,
} from "#/lib/preferred-contact";
import { logActivity } from "./activity";
import { CLUB_BUSY_MESSAGE, lockClubForWrite } from "./club-write-lock";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import {
	assertStillClubAdmin,
	getMembership,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	requireClubRole,
	requireMembership,
} from "./guards";
import type { DbOrTx } from "./meeting-templates-logic";
import { lockMembershipsAgainstMerge } from "./membership-merge-lock";
import { isSqlState, isUniqueViolation } from "./pg-errors";

export const MENTORSHIP_SELF_MESSAGE = "A member can't mentor themselves.";
export const MENTORSHIP_MEMBER_NOT_FOUND_MESSAGE =
	"Both members must belong to this club.";
export const MENTORSHIP_MEMBER_INACTIVE_MESSAGE =
	"Both members must be active — reactivate them first.";
export const MENTORSHIP_DUPLICATE_MESSAGE =
	"These two are already paired with that focus.";
export const MENTORSHIP_NOT_FOUND_MESSAGE =
	"That mentorship isn't in this club.";
export const MENTORSHIP_ENDED_MESSAGE = "That mentorship has already ended.";
export const MENTOR_BIO_NUL_MESSAGE =
	"A mentor bio can't contain a null character. Remove it and try again.";
export const MENTORSHIP_NOT_YOURS_MESSAGE =
	"Only the member can change their own willing-to-mentor setting.";
export const MENTOR_REQUEST_PENDING_MESSAGE =
	"You already have a request waiting. Withdraw it to ask someone else.";
export const MENTOR_REQUEST_ANSWERED_MESSAGE =
	"That request has already been answered.";
export const MENTOR_REQUEST_NOT_ALLOWED_MESSAGE =
	"Only the mentor or an admin can answer this request.";
export const MENTOR_REQUEST_NOT_YOURS_MESSAGE =
	"Only the member who asked can withdraw a request.";
export const MENTOR_FOCUS_OTHER_NUL_MESSAGE =
	"A focus note can't contain a null character. Remove it and try again.";
export const MENTOR_REQUEST_UNAVAILABLE_MESSAGE =
	"That member isn't taking mentees right now.";

const uuid = z.string().uuid();
const focus = z.enum(MENTORSHIP_FOCUSES).nullable();
const focusOther = z
	.string()
	.trim()
	.max(MENTORSHIP_FOCUS_OTHER_MAX)
	// Postgres text cannot hold NUL; the write would 500 instead of refusing.
	.refine((t) => !t.includes("\u0000"), {
		message: MENTOR_FOCUS_OTHER_NUL_MESSAGE,
	})
	.nullable()
	.optional();

/** Free text only with `other`, trimmed, and a blank one is none. */
function normalizeFocusOther(
	f: MentorshipFocus | null,
	text: string | null | undefined,
): string | null {
	const trimmed = text?.trim();
	return f === "other" && trimmed ? trimmed : null;
}

export const createMentorshipSchema = z
	.object({
		clubId: uuid,
		mentorMemberId: uuid,
		menteeMemberId: uuid,
		focus,
		focusOther,
	})
	.strict();
export const endMentorshipSchema = z
	.object({ clubId: uuid, mentorshipId: uuid })
	.strict();
export const setMentorshipFocusSchema = z
	.object({ clubId: uuid, mentorshipId: uuid, focus, focusOther })
	.strict();
/**
 * A mentor request (#1209): the club, the mentor and the focus. The mentee is
 * the SESSION's own membership, never named in input. The focus defaults to
 * `new_member`; a blank `other` text is none.
 */
export const requestMentorSchema = z
	.object({
		clubId: uuid,
		mentorMemberId: uuid,
		focus: z.enum(MENTORSHIP_FOCUSES).default("new_member"),
		focusOther,
	})
	.strict();
export const withdrawMentorRequestSchema = z
	.object({ requestId: uuid })
	.strict();
/** The club is read off the request row, never taken from input. */
export const decideMentorRequestSchema = z
	.object({ requestId: uuid, accept: z.boolean() })
	.strict();
/** The member's own flag: the club and the value, nothing that names a member. */
export const setWillingToMentorSchema = z
	.object({ clubId: uuid, willing: z.boolean() })
	.strict();
/**
 * The member's own mentor bio (#945): the club and the text, nothing that names
 * a member. Empty (after trimming) clears it.
 */
export const setMyMentorBioSchema = z
	.object({
		clubId: uuid,
		bio: z
			.string()
			.trim()
			.max(MENTOR_BIO_MAX)
			// Postgres text cannot hold NUL; the write would 500 instead of refusing.
			.refine((b) => !b.includes("\u0000"), {
				message: MENTOR_BIO_NUL_MESSAGE,
			}),
	})
	.strict();

/** A willing mentor on the Find a mentor page (#945). No contact details. */
export interface MentorListing {
	memberId: string;
	name: string;
	mentorBio: string | null;
	/** Active pairings, any focus, with them as the mentor. */
	activeMenteeCount: number;
}

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The other party of a pairing, as a party or an admin sees them. */
export interface MentorshipParty {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	/** EFFECTIVE (`effectivePreferredContact`), never the raw column. */
	preferredContact: ContactMethod | null;
}

export interface MentorshipRow {
	id: string;
	focus: MentorshipFocus | null;
	focusOther: string | null;
	startedAt: Date;
	/** The OTHER party: the mentor in a mentee's list, the mentee in a mentor's. */
	member: MentorshipParty;
}

/** What a pairing view carries for anyone: the flag and the active pairings. */
export interface MentorshipLists {
	willingToMentor: boolean;
	/** Active pairings where the subject is the mentee. */
	mentors: MentorshipRow[];
	/** Active pairings where the subject is the mentor. */
	mentees: MentorshipRow[];
}

/** The member's OWN view: the lists plus their bio and listing (#945). */
export interface MyMentorships extends MentorshipLists {
	/** The caller's mentor bio (#945), or null. Kept when the flag is off. */
	mentorBio: string | null;
	/**
	 * Whether Find a mentor lists the caller: willing AND `mentor_listed_at` set.
	 * False for a flag the Easy-Speak import set that the member has not confirmed.
	 */
	mentorListed: boolean;
}

/**
 * An admin's (or read-only impersonator's) view of one member. Carries NO bio
 * and no listing state: the bio is shown only on Find a mentor (#945), and the
 * admin pairing views see every willing member regardless of listing.
 */
export interface MemberMentorships extends MentorshipLists {
	/** Active members of the club offered as a mentor, willing first. */
	candidates: MentorCandidate[];
}

export interface ClubMentorshipRow {
	id: string;
	focus: MentorshipFocus | null;
	focusOther: string | null;
	startedAt: Date;
	mentor: { id: string; name: string };
	mentee: { id: string; name: string };
}

export interface ClubMentorships {
	active: ClubMentorshipRow[];
	/** Active members with no active mentor (as mentee, any focus). */
	unpaired: { id: string; name: string; inOrientation: boolean }[];
	/** Active members who said they are willing to mentor. */
	willing: { id: string; name: string }[];
}

/** One side of a request as the other side sees them: name and how to reach them. */
export interface MentorRequestParty {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	/** EFFECTIVE (`effectivePreferredContact`), never the raw column. */
	preferredContact: ContactMethod | null;
}

export type MentorRequestStatus =
	(typeof mentorshipRequests.$inferSelect)["status"];

/** The caller's own latest request as mentee, any status (#1209). */
export interface OutgoingMentorRequest {
	id: string;
	status: MentorRequestStatus;
	focus: MentorshipFocus;
	focusOther: string | null;
	createdAt: Date;
	mentor: MentorRequestParty;
}

/** A pending request the caller, as mentor, may answer. */
export interface IncomingMentorRequest {
	id: string;
	focus: MentorshipFocus;
	focusOther: string | null;
	createdAt: Date;
	mentee: MentorRequestParty;
}

export interface MyMentorRequests {
	outgoing: OutgoingMentorRequest | null;
	incoming: IncomingMentorRequest[];
}

/** A pending request on the admin's list (#1209). Names only. */
export interface ClubPendingMentorRequest {
	id: string;
	focus: MentorshipFocus;
	focusOther: string | null;
	createdAt: Date;
	mentor: { id: string; name: string };
	mentee: { id: string; name: string };
	/**
	 * A party is no longer an active member. Accept is refused, so the admin
	 * list offers only Decline, which clears the request (#1209).
	 */
	partyInactive: boolean;
}

// ---------------------------------------------------------------------------
// The member's own flag
// ---------------------------------------------------------------------------

/**
 * The caller's OWN membership id in the club. `requireMembership` refuses a
 * non-member, an inactive member and an archived club, and admits a read-write
 * impersonator as a memberless actor (`id: null`), refused here: the flag is a
 * statement the member makes about themselves.
 */
export async function ownMembershipId(
	userId: string,
	club: string,
): Promise<string> {
	const membership = await requireMembership(userId, club);
	if (membership.id === null) throw new Error(MENTORSHIP_NOT_YOURS_MESSAGE);
	return membership.id;
}

/**
 * Who Find a mentor lists, and who may be the target of a request (#945,
 * #1209): willing AND listed. `mentor_listed_at` is set only by the member's own
 * act (`setMyWillingToMentor(true)`, saving a bio), never by the Easy-Speak
 * import, so a flag the import set stays off the page until the member confirms
 * it. Admin pairing views read `willing_to_mentor` alone and are unchanged.
 */
export function listedMentorWhere() {
	return and(
		eq(members.willingToMentor, true),
		isNotNull(members.mentorListedAt),
	);
}

/**
 * Set or clear "willing to mentor" on the caller's OWN membership. Turning it
 * on is the member's confirmation, so it lists them (`mentor_listed_at`, kept if
 * already set); turning it off clears the listing.
 */
export async function setMyWillingToMentor(input: {
	userId: string;
	clubId: string;
	willing: boolean;
}): Promise<{ willingToMentor: boolean }> {
	const id = await ownMembershipId(input.userId, input.clubId);
	await db
		.update(members)
		.set({
			willingToMentor: input.willing,
			mentorListedAt: input.willing
				? sql`coalesce(${members.mentorListedAt}, now())`
				: null,
		})
		.where(eq(members.id, id));
	return { willingToMentor: input.willing };
}

/**
 * Set or clear the mentor bio on the caller's OWN membership (#945). The row
 * is resolved from the session, as the flag's is; the input names no member.
 * Blank after trimming stores null. Saving a bio while willing is the
 * member's confirmation, so it lists them (`mentor_listed_at`, kept if already
 * set); with the flag off it lists nobody. Logs `member_edit` against the
 * member's own membership. A read-write impersonator never reaches here:
 * `ownMembershipId` refuses a memberless actor.
 */
export async function setMyMentorBio(input: {
	userId: string;
	clubId: string;
	bio: string;
}): Promise<{ mentorBio: string | null }> {
	const id = await ownMembershipId(input.userId, input.clubId);
	const mentorBio = input.bio.trim() === "" ? null : input.bio.trim();
	await db.transaction(async (tx) => {
		await tx
			.update(members)
			.set({
				mentorBio,
				mentorListedAt: sql`case when ${members.willingToMentor} then coalesce(${members.mentorListedAt}, now()) else ${members.mentorListedAt} end`,
			})
			.where(eq(members.id, id));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: id,
			action: "member_edit",
			targetType: "member",
			targetId: id,
			detail: { mentorBio: mentorBio === null ? "cleared" : "set" },
		});
	});
	return { mentorBio };
}

// ---------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------

/**
 * Both memberships, locked, in the club and ACTIVE, and not the same one.
 * Throws the message the admin sees. Run under the club write lock, which
 * `collapseMemberships` also takes, so a pairing cannot land on a membership
 * mid-merge.
 */
async function assertPairable(
	tx: Tx,
	clubId: string,
	mentorMemberId: string,
	menteeMemberId: string,
): Promise<void> {
	if (mentorMemberId === menteeMemberId) {
		throw new Error(MENTORSHIP_SELF_MESSAGE);
	}
	const rows = await tx
		.select({ id: members.id, status: members.status })
		.from(members)
		.where(
			and(
				eq(members.clubId, clubId),
				inArray(members.id, [mentorMemberId, menteeMemberId]),
			),
		)
		.for("share");
	if (rows.length !== 2) throw new Error(MENTORSHIP_MEMBER_NOT_FOUND_MESSAGE);
	if (rows.some((r) => r.status !== "active")) {
		throw new Error(MENTORSHIP_MEMBER_INACTIVE_MESSAGE);
	}
}

/**
 * Map the DB's own refusals to the admin's message. The write path checks
 * self-pairing first, so the CHECK is a backstop; the partial unique index is
 * the ONLY thing that catches two admins pairing the same two at once.
 */
function translateDbRefusal(err: unknown): never {
	if (isUniqueViolation(err)) throw new Error(MENTORSHIP_DUPLICATE_MESSAGE);
	if (isSqlState(err, "23514")) throw new Error(MENTORSHIP_SELF_MESSAGE);
	throw err;
}

/**
 * The pairing write itself: both parties checked, the row inserted, the
 * activity logged. Runs on the caller's transaction, UNDER the club write lock
 * the caller already took (`createMentorship`, and `decideMentorRequest` when a
 * mentor accepts, #1209). Throws the raw unique violation; callers translate.
 */
async function insertMentorshipInTx(
	tx: Tx,
	input: {
		clubId: string;
		mentorMemberId: string;
		menteeMemberId: string;
		focus: MentorshipFocus | null;
		focusOther: string | null;
		actorMemberId: string | null;
	},
): Promise<{ id: string }> {
	await assertPairable(
		tx,
		input.clubId,
		input.mentorMemberId,
		input.menteeMemberId,
	);
	const [row] = await tx
		.insert(mentorships)
		.values({
			clubId: input.clubId,
			mentorMemberId: input.mentorMemberId,
			menteeMemberId: input.menteeMemberId,
			focus: input.focus,
			focusOther: input.focusOther,
			createdByMemberId: input.actorMemberId,
		})
		.returning({ id: mentorships.id, startedAt: mentorships.startedAt });
	if (!row) throw new Error("Mentorship insert returned no row.");
	await logActivity(tx, {
		clubId: input.clubId,
		actorMemberId: input.actorMemberId,
		action: "member_edit",
		targetType: "member",
		targetId: input.menteeMemberId,
		detail: {
			mentorship: "created",
			mentorshipId: row.id,
			mentorMemberId: input.mentorMemberId,
			menteeMemberId: input.menteeMemberId,
			focus: input.focus,
			focusOther: input.focusOther,
		},
	});
	return { id: row.id };
}

/**
 * Pair a mentor with a mentee (an admin's write; the caller gates it).
 *
 * `conn` is the executor the write runs on. It defaults to the pooled client,
 * which makes `conn.transaction` the transaction the lock, the check and the
 * insert need; given a caller's transaction it is a savepoint inside it, so the
 * pairing can see that caller's uncommitted club and members (the fixture
 * builder, #1198) and rolls back with it. Every existing caller passes none.
 */
export async function createMentorship(
	input: {
		clubId: string;
		mentorMemberId: string;
		menteeMemberId: string;
		focus: MentorshipFocus | null;
		focusOther?: string | null;
		actorMemberId: string | null;
	},
	conn: DbOrTx = db,
): Promise<{ id: string }> {
	const focusOtherValue = normalizeFocusOther(input.focus, input.focusOther);
	try {
		return await conn.transaction(async (tx) => {
			await lockClubForWrite(tx, input.clubId);
			return insertMentorshipInTx(tx, {
				...input,
				focusOther: focusOtherValue,
			});
		});
	} catch (err) {
		translateDbRefusal(err);
	}
}

/** The ACTIVE pairing named, in the club, locked; throws otherwise. */
async function lockActivePairing(tx: Tx, clubId: string, mentorshipId: string) {
	const [row] = await tx
		.select({
			id: mentorships.id,
			mentorMemberId: mentorships.mentorMemberId,
			menteeMemberId: mentorships.menteeMemberId,
			focus: mentorships.focus,
			focusOther: mentorships.focusOther,
			endedAt: mentorships.endedAt,
		})
		.from(mentorships)
		.where(
			and(eq(mentorships.id, mentorshipId), eq(mentorships.clubId, clubId)),
		)
		.for("update")
		.limit(1);
	if (!row) throw new Error(MENTORSHIP_NOT_FOUND_MESSAGE);
	if (row.endedAt !== null) throw new Error(MENTORSHIP_ENDED_MESSAGE);
	return row;
}

/** End an active pairing (an admin's write). The row is kept as history. */
export async function endMentorship(input: {
	clubId: string;
	mentorshipId: string;
	actorMemberId: string | null;
}): Promise<void> {
	await db.transaction(async (tx) => {
		// First, like create and set-focus, so every mentorship writer orders
		// against `collapseMemberships` the same way.
		await lockClubForWrite(tx, input.clubId);
		const row = await lockActivePairing(tx, input.clubId, input.mentorshipId);
		const endedAt = new Date();
		await tx
			.update(mentorships)
			.set({ endedAt })
			.where(eq(mentorships.id, row.id));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: row.menteeMemberId,
			detail: {
				mentorship: "ended",
				mentorshipId: row.id,
				mentorMemberId: row.mentorMemberId,
				menteeMemberId: row.menteeMemberId,
			},
		});
	});
}

/** Change an active pairing's focus (an admin's write). */
export async function setMentorshipFocus(input: {
	clubId: string;
	mentorshipId: string;
	focus: MentorshipFocus | null;
	focusOther?: string | null;
	actorMemberId: string | null;
}): Promise<void> {
	const focusOtherValue = normalizeFocusOther(input.focus, input.focusOther);
	try {
		await db.transaction(async (tx) => {
			await lockClubForWrite(tx, input.clubId);
			// The membership merge lock (#1035), SHARED, on both members BEFORE the
			// pairing row lock (#1217). A removal holds it EXCLUSIVE, then the
			// member row, then cascades into this pairing; this writer used to hold
			// the pairing and then ask `assertPairable` for the members FOR SHARE:
			// 40P01. The ids are read unlocked and checked again under the row lock:
			// a merge (`collapseMemberships`, which re-points `MENTORSHIP_MEMBER_FKS`)
			// can move either one between the peek and the lock, and then the locks
			// above name the wrong members.
			const [peek] = await tx
				.select({
					mentorMemberId: mentorships.mentorMemberId,
					menteeMemberId: mentorships.menteeMemberId,
				})
				.from(mentorships)
				.where(
					and(
						eq(mentorships.id, input.mentorshipId),
						eq(mentorships.clubId, input.clubId),
					),
				)
				.limit(1);
			if (peek) {
				await lockMembershipsAgainstMerge(tx, [
					peek.mentorMemberId,
					peek.menteeMemberId,
				]);
			}
			const row = await lockActivePairing(tx, input.clubId, input.mentorshipId);
			if (
				peek &&
				(row.mentorMemberId !== peek.mentorMemberId ||
					row.menteeMemberId !== peek.menteeMemberId)
			) {
				throw new Error(CLUB_BUSY_MESSAGE);
			}
			// Same check as a new pairing: both still in the club and ACTIVE. A
			// pairing with a lapsed member is dormant (the reads hide it), and
			// re-focusing it would be editing something nobody can see.
			await assertPairable(
				tx,
				input.clubId,
				row.mentorMemberId,
				row.menteeMemberId,
			);
			await tx
				.update(mentorships)
				.set({ focus: input.focus, focusOther: focusOtherValue })
				.where(eq(mentorships.id, row.id));
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "member_edit",
				targetType: "member",
				targetId: row.menteeMemberId,
				detail: {
					mentorship: "focus_changed",
					mentorshipId: row.id,
					before: { focus: row.focus, focusOther: row.focusOther },
					after: { focus: input.focus, focusOther: focusOtherValue },
				},
			});
		});
	} catch (err) {
		translateDbRefusal(err);
	}
}

// ---------------------------------------------------------------------------
// Mentor requests (#1209)
// ---------------------------------------------------------------------------

/**
 * The active pairing of one mentor and one mentee on one focus, if any. The
 * partial unique index allows one; `requestMentor` reads it to refuse a request
 * for a pairing that already exists, `decideMentorRequest` locks it to link it.
 */
async function findActivePairing(
	tx: Tx,
	key: {
		mentorMemberId: string;
		menteeMemberId: string;
		focus: MentorshipFocus;
	},
	lock: boolean,
): Promise<{ id: string } | undefined> {
	const where = and(
		eq(mentorships.mentorMemberId, key.mentorMemberId),
		eq(mentorships.menteeMemberId, key.menteeMemberId),
		eq(mentorships.focus, key.focus),
		isNull(mentorships.endedAt),
	);
	const base = tx.select({ id: mentorships.id }).from(mentorships).where(where);
	const [row] = lock ? await base.for("update").limit(1) : await base.limit(1);
	return row;
}

/**
 * Ask a listed mentor to mentor the CALLER (the mentee is the session's own
 * membership). One transaction under the club write lock: the mentor is an
 * active, willing AND listed member of the same club (`listedMentorWhere`, the
 * same set Find a mentor shows), not the mentee, with no active pairing
 * between them on that focus. The one-pending-per-mentee unique index is what
 * refuses a second request, including two racing ones. Returns the mentor's
 * contact so the mentee's draft needs no second read.
 */
export async function requestMentor(input: {
	userId: string;
	clubId: string;
	mentorMemberId: string;
	focus?: MentorshipFocus;
	focusOther?: string | null;
}): Promise<{ requestId: string; mentor: MentorRequestParty }> {
	const menteeMemberId = await ownMembershipId(input.userId, input.clubId);
	const focus = input.focus ?? "new_member";
	const focusOtherValue = normalizeFocusOther(focus, input.focusOther);
	const cc = await loadClubDefaultCountryCode(input.clubId);
	try {
		return await db.transaction(async (tx) => {
			await lockClubForWrite(tx, input.clubId);
			if (input.mentorMemberId === menteeMemberId) {
				throw new Error(MENTORSHIP_SELF_MESSAGE);
			}
			const [mentor] = await tx
				.select({
					id: members.id,
					name: members.name,
					email: mentorPersonR.email,
					phone: mentorPersonR.phone,
					preferredContact: mentorPersonR.preferredContact,
				})
				.from(members)
				.innerJoin(mentorPersonR, eq(mentorPersonR.id, members.personId))
				.where(
					and(
						eq(members.id, input.mentorMemberId),
						eq(members.clubId, input.clubId),
						eq(members.status, "active"),
						listedMentorWhere(),
					),
				)
				.for("share", { of: members })
				.limit(1);
			if (!mentor) throw new Error(MENTOR_REQUEST_UNAVAILABLE_MESSAGE);
			const paired = await findActivePairing(
				tx,
				{
					mentorMemberId: input.mentorMemberId,
					menteeMemberId,
					focus,
				},
				false,
			);
			if (paired) throw new Error(MENTORSHIP_DUPLICATE_MESSAGE);
			const [row] = await tx
				.insert(mentorshipRequests)
				.values({
					clubId: input.clubId,
					menteeMemberId,
					mentorMemberId: input.mentorMemberId,
					focus,
					focusOther: focusOtherValue,
				})
				.returning({ id: mentorshipRequests.id });
			if (!row) throw new Error("Mentor request insert returned no row.");
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: menteeMemberId,
				action: "member_edit",
				targetType: "member",
				targetId: menteeMemberId,
				detail: {
					mentorRequest: "created",
					requestId: row.id,
					mentorMemberId: input.mentorMemberId,
					focus,
					focusOther: focusOtherValue,
				},
			});
			return {
				requestId: row.id,
				mentor: requestParty({ id: mentor.id, name: mentor.name }, mentor, cc),
			};
		});
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(MENTOR_REQUEST_PENDING_MESSAGE);
		}
		throw err;
	}
}

/**
 * The mentee takes their request back. Only the request's own mentee, and only
 * while it is `pending`: the UPDATE carries both, so a decision that landed
 * first (the row lock `decideMentorRequest` holds makes this wait for it)
 * leaves zero rows and the refusal below. A missing request, one in a club the
 * caller does not belong to, and someone else's all answer the same, so an id
 * says nothing about whether it exists or whose it is.
 */
export async function withdrawMentorRequest(input: {
	userId: string;
	requestId: string;
}): Promise<void> {
	const [req] = await db
		.select({
			clubId: mentorshipRequests.clubId,
			menteeMemberId: mentorshipRequests.menteeMemberId,
		})
		.from(mentorshipRequests)
		.where(eq(mentorshipRequests.id, input.requestId))
		.limit(1);
	if (!req) throw new Error(MENTOR_REQUEST_NOT_YOURS_MESSAGE);
	let own: string;
	try {
		own = await ownMembershipId(input.userId, req.clubId);
	} catch (err) {
		// Not a member of that club reads as "not yours", not as "no such club".
		if (
			err instanceof Error &&
			(err.message === NOT_A_MEMBER_MESSAGE ||
				err.message === MENTORSHIP_NOT_YOURS_MESSAGE)
		) {
			throw new Error(MENTOR_REQUEST_NOT_YOURS_MESSAGE);
		}
		throw err;
	}
	if (own !== req.menteeMemberId) {
		throw new Error(MENTOR_REQUEST_NOT_YOURS_MESSAGE);
	}
	await db.transaction(async (tx) => {
		const updated = await tx
			.update(mentorshipRequests)
			.set({
				status: "withdrawn",
				decidedAt: new Date(),
				decidedByMemberId: own,
			})
			.where(
				and(
					eq(mentorshipRequests.id, input.requestId),
					eq(mentorshipRequests.menteeMemberId, own),
					eq(mentorshipRequests.status, "pending"),
				),
			)
			.returning({ id: mentorshipRequests.id });
		if (updated.length === 0) throw new Error(MENTOR_REQUEST_ANSWERED_MESSAGE);
		await logActivity(tx, {
			clubId: req.clubId,
			actorMemberId: own,
			action: "member_edit",
			targetType: "member",
			targetId: own,
			detail: { mentorRequest: "withdrawn", requestId: input.requestId },
		});
	});
}

/** In which capacity the caller may answer: the request's mentor, or an admin. */
export type MentorRequestActingAs = "mentor" | "admin";

/**
 * Who may answer a request: its mentor, or a club admin. The club and the
 * mentor are read off the REQUEST row, never from input, so a caller cannot
 * name a club they administer to answer someone else's. Anyone else, a
 * request that does not exist and a club the caller is not in get the one
 * message. Returns the membership id to record as the actor (null for a
 * read-write impersonator, who has none) and the capacity, which
 * `decideMentorRequest` re-checks under the lock.
 */
export async function authorizeMentorRequestDecision(
	userId: string,
	requestId: string,
): Promise<{ actorMemberId: string | null; actingAs: MentorRequestActingAs }> {
	const [req] = await db
		.select({
			clubId: mentorshipRequests.clubId,
			mentorMemberId: mentorshipRequests.mentorMemberId,
		})
		.from(mentorshipRequests)
		.where(eq(mentorshipRequests.id, requestId))
		.limit(1);
	if (!req) throw new Error(MENTOR_REQUEST_NOT_ALLOWED_MESSAGE);
	const refuse = (err: unknown): never => {
		if (
			err instanceof Error &&
			(err.message === NOT_A_MEMBER_MESSAGE ||
				err.message === NO_PERMISSION_MESSAGE)
		) {
			throw new Error(MENTOR_REQUEST_NOT_ALLOWED_MESSAGE);
		}
		throw err;
	};
	let membership: Awaited<ReturnType<typeof requireMembership>>;
	try {
		membership = await requireMembership(userId, req.clubId);
	} catch (err) {
		return refuse(err);
	}
	if (membership.id !== null && membership.id === req.mentorMemberId) {
		return { actorMemberId: membership.id, actingAs: "mentor" };
	}
	try {
		const admin = await requireClubRole(userId, req.clubId, ["admin"]);
		return { actorMemberId: admin.id, actingAs: "admin" };
	} catch (err) {
		return refuse(err);
	}
}

/**
 * Answer a request (the caller has authorized: `authorizeMentorRequestDecision`).
 * One transaction: the club write lock, then the request row `FOR UPDATE`, so
 * two answers (the mentor's and an admin's) take turns and the second finds it
 * no longer `pending`. The actor is RE-CHECKED once both are held: authorizing
 * ran before the lock, and an admin demoted, or a mentor deactivated, while
 * queued on it must not commit. Accept pairs them on the request's focus with
 * `actorMemberId` as creator, or links the identical active pairing an admin
 * already made; it is refused while either party is not active. A mentor who
 * stopped being listed after the request may still answer: the flag gates NEW
 * requests only. Decline writes only the request.
 */
export async function decideMentorRequest(input: {
	requestId: string;
	accept: boolean;
	userId: string;
	actingAs: MentorRequestActingAs;
	actorMemberId: string | null;
}): Promise<{ status: "accepted" | "declined"; mentorshipId: string | null }> {
	const [head] = await db
		.select({ clubId: mentorshipRequests.clubId })
		.from(mentorshipRequests)
		.where(eq(mentorshipRequests.id, input.requestId))
		.limit(1);
	if (!head) throw new Error(MENTOR_REQUEST_ANSWERED_MESSAGE);
	try {
		return await db.transaction(async (tx) => {
			await lockClubForWrite(tx, head.clubId);
			const [req] = await tx
				.select()
				.from(mentorshipRequests)
				.where(eq(mentorshipRequests.id, input.requestId))
				.for("update")
				.limit(1);
			if (!req) throw new Error(MENTOR_REQUEST_ANSWERED_MESSAGE);
			await assertStillMayAnswer(tx, input, req);
			if (req.status !== "pending") {
				throw new Error(MENTOR_REQUEST_ANSWERED_MESSAGE);
			}
			const decidedAt = new Date();
			let mentorshipId: string | null = null;
			if (input.accept) {
				const parties = await tx
					.select({
						id: members.id,
						name: members.name,
						status: members.status,
					})
					.from(members)
					.where(
						and(
							eq(members.clubId, req.clubId),
							inArray(members.id, [req.mentorMemberId, req.menteeMemberId]),
						),
					)
					.for("share");
				if (parties.length !== 2) {
					throw new Error(MENTORSHIP_MEMBER_NOT_FOUND_MESSAGE);
				}
				const gone = parties.find((p) => p.status !== "active");
				if (gone)
					throw new Error(`${gone.name} is no longer an active member.`);
				const existing = await findActivePairing(
					tx,
					{
						mentorMemberId: req.mentorMemberId,
						menteeMemberId: req.menteeMemberId,
						focus: req.focus,
					},
					true,
				);
				mentorshipId = existing
					? existing.id
					: (
							await insertMentorshipInTx(tx, {
								clubId: req.clubId,
								mentorMemberId: req.mentorMemberId,
								menteeMemberId: req.menteeMemberId,
								focus: req.focus,
								focusOther: req.focusOther,
								actorMemberId: input.actorMemberId,
							})
						).id;
			}
			const status = input.accept ? "accepted" : "declined";
			await tx
				.update(mentorshipRequests)
				.set({
					status,
					mentorshipId,
					decidedByMemberId: input.actorMemberId,
					decidedAt,
				})
				.where(eq(mentorshipRequests.id, req.id));
			await logActivity(tx, {
				clubId: req.clubId,
				actorMemberId: input.actorMemberId,
				action: "member_edit",
				targetType: "member",
				targetId: req.menteeMemberId,
				detail: {
					mentorRequest: status,
					requestId: req.id,
					mentorMemberId: req.mentorMemberId,
					mentorshipId,
				},
			});
			return { status, mentorshipId };
		});
	} catch (err) {
		translateDbRefusal(err);
	}
}

/**
 * The actor's right to answer, asked again on the transaction that holds the
 * club lock and the request row. An admin goes through `assertStillClubAdmin`
 * (the repo's one re-check); the mentor must still be THE request's mentor,
 * resolved from the session's user, active, in a club that is not archived.
 */
async function assertStillMayAnswer(
	tx: Tx,
	input: {
		userId: string;
		actingAs: MentorRequestActingAs;
		actorMemberId: string | null;
	},
	req: { clubId: string; mentorMemberId: string },
): Promise<void> {
	const refused = () => new Error(MENTOR_REQUEST_NOT_ALLOWED_MESSAGE);
	if (input.actingAs === "admin") {
		try {
			await assertStillClubAdmin(tx, input.userId, req.clubId);
		} catch (err) {
			if (
				err instanceof Error &&
				(err.message === NOT_A_MEMBER_MESSAGE ||
					err.message === NO_PERMISSION_MESSAGE)
			) {
				throw refused();
			}
			throw err;
		}
		return;
	}
	const membership = await getMembership(input.userId, req.clubId, tx);
	if (
		!membership ||
		membership.status !== "active" ||
		membership.archivedAt !== null ||
		membership.id !== req.mentorMemberId ||
		membership.id !== input.actorMemberId
	) {
		throw refused();
	}
}

// ---------------------------------------------------------------------------
// Reads (never write)
// ---------------------------------------------------------------------------

const other = alias(members, "other_party");
const selfParty = alias(members, "self_party");
/** The other party's Person: their phone lives there, not on the membership
 *  (#906). */
const otherPerson = alias(people, "other_person");

/**
 * A pairing COUNTS (is shown, ticks "Get a mentor", keeps a mentee off the
 * unpaired list) only while it is not ended AND both parties are ACTIVE
 * members. Deactivating a member leaves the row alone, so reactivating them
 * restores the pairing with no data change; until then it is dormant. The
 * write side (`assertPairable`) refuses an inactive party for the same reason.
 * Restated in SQL in each reader below and in `loadOrientationFacts`; the
 * client-side statement is `isActivePairing` in `#/lib/mentorship`.
 */

/**
 * Active pairings with `membershipId` on one side, each carrying the OTHER
 * party's name and contact.
 */
async function activePairingsFor(
	membershipId: string,
	side: "mentor" | "mentee",
	cc: string | null,
): Promise<MentorshipRow[]> {
	const self =
		side === "mentee" ? mentorships.menteeMemberId : mentorships.mentorMemberId;
	const otherCol =
		side === "mentee" ? mentorships.mentorMemberId : mentorships.menteeMemberId;
	const rows = await db
		.select({
			id: mentorships.id,
			focus: mentorships.focus,
			focusOther: mentorships.focusOther,
			startedAt: mentorships.startedAt,
			otherId: other.id,
			otherName: other.name,
			otherEmail: otherPerson.email,
			otherPhone: otherPerson.phone,
			otherPreferred: otherPerson.preferredContact,
		})
		.from(mentorships)
		.innerJoin(other, eq(other.id, otherCol))
		.innerJoin(otherPerson, eq(otherPerson.id, other.personId))
		.innerJoin(selfParty, eq(selfParty.id, self))
		.where(
			and(
				eq(self, membershipId),
				isNull(mentorships.endedAt),
				eq(other.status, "active"),
				eq(selfParty.status, "active"),
			),
		)
		.orderBy(asc(mentorships.startedAt), asc(mentorships.id));
	return rows.map((r) => ({
		id: r.id,
		focus: r.focus,
		focusOther: r.focusOther,
		startedAt: r.startedAt,
		member: {
			id: r.otherId,
			name: r.otherName,
			email: r.otherEmail,
			phone: coalesceToE164(r.otherPhone, cc),
			// Judged on the STORED phone, as `requestParty` does.
			preferredContact: effectivePreferredContact(r.otherPreferred, {
				phone: r.otherPhone,
				email: r.otherEmail,
			}),
		},
	}));
}

/**
 * The `table.column` spellings of this table's two cascading foreign keys to
 * `members`, as the guest-conversion undo's FK drift guard names them
 * (`UNDO_CASCADE_CHECKS`). Here so the table's name stays inside the gated
 * logic modules (`mentorship-not-public.guard.test.ts`).
 */
export const MENTORSHIP_MEMBER_FKS = [
	"mentorships.mentor_member_id",
	"mentorships.mentee_member_id",
];

/** The same for `mentorship_requests` (#945), which cascades off the member alike. */
export const MENTOR_REQUEST_MEMBER_FKS = [
	"mentorship_requests.mentor_member_id",
	"mentorship_requests.mentee_member_id",
];

/**
 * Whether the membership is in ANY pairing, as mentor or mentee, ended or not.
 * An existence check: it returns no pairing data. Its caller is the gated
 * guest-conversion undo, which runs it inside its own transaction (`conn`) to
 * refuse before a cascading delete takes the pairings (#1202).
 */
export async function memberHasMentorship(
	conn: DbOrTx,
	membershipId: string,
): Promise<boolean> {
	const rows = await conn
		.select({ id: mentorships.id })
		.from(mentorships)
		.where(
			or(
				eq(mentorships.mentorMemberId, membershipId),
				eq(mentorships.menteeMemberId, membershipId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Whether the membership sent or received ANY mentor request, any status
 * (#945). The undo refuses on it separately from a pairing so the admin reads
 * what is actually there.
 */
export async function memberHasMentorRequest(
	conn: DbOrTx,
	membershipId: string,
): Promise<boolean> {
	const requests = await conn
		.select({ id: mentorshipRequests.id })
		.from(mentorshipRequests)
		.where(
			or(
				eq(mentorshipRequests.mentorMemberId, membershipId),
				eq(mentorshipRequests.menteeMemberId, membershipId),
			),
		)
		.limit(1);
	return requests.length > 0;
}

/**
 * The caller's own mentors and mentees (dashboard). Takes the membership the
 * READ GATE resolved, never an id from input. Null when it does not exist.
 */
export async function loadMyMentorships(
	membershipId: string,
): Promise<MyMentorships | null> {
	const [row] = await db
		.select({
			clubId: members.clubId,
			willing: members.willingToMentor,
			bio: members.mentorBio,
			listedAt: members.mentorListedAt,
		})
		.from(members)
		.where(eq(members.id, membershipId))
		.limit(1);
	if (!row) return null;
	const cc = await loadClubDefaultCountryCode(row.clubId);
	const [mentors, mentees] = await Promise.all([
		activePairingsFor(membershipId, "mentee", cc),
		activePairingsFor(membershipId, "mentor", cc),
	]);
	return {
		willingToMentor: row.willing,
		mentorBio: row.bio,
		mentorListed: row.willing && row.listedAt !== null,
		mentors,
		mentees,
	};
}

/**
 * One member's pairings and the mentor picker, for an admin on the member
 * page. A member of another club answers null.
 */
export async function loadMemberMentorships(input: {
	clubId: string;
	memberId: string;
}): Promise<MemberMentorships | null> {
	const [row] = await db
		.select({ id: members.id })
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		)
		.limit(1);
	if (!row) return null;
	const [mine, pool] = await Promise.all([
		loadMyMentorships(row.id),
		db
			.select({
				id: members.id,
				name: members.name,
				willingToMentor: members.willingToMentor,
			})
			.from(members)
			.where(
				and(eq(members.clubId, input.clubId), eq(members.status, "active")),
			),
	]);
	if (!mine) return null;
	// Pick the fields: the member's own bio and listing are not the admin's.
	return {
		willingToMentor: mine.willingToMentor,
		mentors: mine.mentors,
		mentees: mine.mentees,
		candidates: orderMentorCandidates(pool, row.id),
	};
}

const mentorM = alias(members, "mentor_m");
const menteeM = alias(members, "mentee_m");

/**
 * Every active pairing in the club, the active members with no active mentor,
 * and who is willing to mentor (an admin's list; #942 builds on it).
 */
export async function loadClubMentorships(
	clubId: string,
): Promise<ClubMentorships> {
	const [active, unpaired, willing] = await Promise.all([
		db
			.select({
				id: mentorships.id,
				focus: mentorships.focus,
				focusOther: mentorships.focusOther,
				startedAt: mentorships.startedAt,
				mentorId: mentorM.id,
				mentorName: mentorM.name,
				menteeId: menteeM.id,
				menteeName: menteeM.name,
			})
			.from(mentorships)
			.innerJoin(mentorM, eq(mentorM.id, mentorships.mentorMemberId))
			.innerJoin(menteeM, eq(menteeM.id, mentorships.menteeMemberId))
			.where(
				and(
					eq(mentorships.clubId, clubId),
					isNull(mentorships.endedAt),
					eq(mentorM.status, "active"),
					eq(menteeM.status, "active"),
				),
			)
			.orderBy(asc(menteeM.name), asc(mentorM.name)),
		db
			.select({
				id: members.id,
				name: members.name,
				inOrientation: sql<boolean>`${members.orientationStartedAt} is not null`,
			})
			.from(members)
			.where(
				and(
					eq(members.clubId, clubId),
					eq(members.status, "active"),
					notExists(
						// A mentee whose only mentor is inactive counts as unpaired.
						db
							.select({ one: sql`1` })
							.from(mentorships)
							.innerJoin(mentorM, eq(mentorM.id, mentorships.mentorMemberId))
							.where(
								and(
									eq(mentorships.menteeMemberId, members.id),
									isNull(mentorships.endedAt),
									eq(mentorM.status, "active"),
								),
							),
					),
				),
			)
			.orderBy(asc(members.name)),
		db
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(
				and(
					eq(members.clubId, clubId),
					eq(members.status, "active"),
					eq(members.willingToMentor, true),
				),
			)
			.orderBy(asc(members.name)),
	]);
	return {
		active: active.map((r) => ({
			id: r.id,
			focus: r.focus,
			focusOther: r.focusOther,
			startedAt: r.startedAt,
			mentor: { id: r.mentorId, name: r.mentorName },
			mentee: { id: r.menteeId, name: r.menteeName },
		})),
		unpaired,
		willing,
	};
}

/**
 * The Find a mentor page's list (#945): the club's ACTIVE members who said they
 * are willing to mentor AND are listed (`listedMentorWhere`), other than the caller, by name. Each carries the bio
 * and how many people they mentor now (active pairings, any focus, with the
 * mentee also active, as everywhere else a pairing counts). No contact details:
 * the member page already shows those to club members. Takes the membership
 * the READ GATE resolved, never an id from input, and writes nothing.
 */
export async function listMentors(
	clubId: string,
	callerMembershipId: string,
): Promise<MentorListing[]> {
	const count = db
		.select({
			mentorId: mentorships.mentorMemberId,
			// People, not pairings: one mentee paired under two foci counts once.
			n: countDistinct(mentorships.menteeMemberId).as("n"),
		})
		.from(mentorships)
		.innerJoin(menteeM, eq(menteeM.id, mentorships.menteeMemberId))
		.where(and(isNull(mentorships.endedAt), eq(menteeM.status, "active")))
		.groupBy(mentorships.mentorMemberId)
		.as("mentee_counts");
	const rows = await db
		.select({
			memberId: members.id,
			name: members.name,
			mentorBio: members.mentorBio,
			n: count.n,
		})
		.from(members)
		.leftJoin(count, eq(count.mentorId, members.id))
		.where(
			and(
				eq(members.clubId, clubId),
				eq(members.status, "active"),
				listedMentorWhere(),
				ne(members.id, callerMembershipId),
			),
		)
		.orderBy(asc(members.name), asc(members.id));
	return rows.map((r) => ({
		memberId: r.memberId,
		name: r.name,
		mentorBio: r.mentorBio,
		activeMenteeCount: r.n ?? 0,
	}));
}

const mentorPersonR = alias(people, "request_mentor_person");
const menteePersonR = alias(people, "request_mentee_person");

function requestParty(
	m: { id: string; name: string },
	person: {
		email: string | null;
		phone: string | null;
		preferredContact: ContactMethod | null;
	},
	cc: string | null,
): MentorRequestParty {
	return {
		id: m.id,
		name: m.name,
		email: person.email,
		phone: coalesceToE164(person.phone, cc),
		// Judged on the STORED phone, the column the writers' WHERE reads.
		preferredContact: effectivePreferredContact(person.preferredContact, {
			phone: person.phone,
			email: person.email,
		}),
	};
}

/**
 * The caller's own requests (#1209): the latest one they made as mentee, any
 * status (the mentor may have gone inactive since; the mentee must still be
 * able to see and withdraw it, because it holds their one pending slot), and
 * the pending ones addressed to them as mentor while BOTH parties are active.
 * Contact comes from each party's Person, as every other pairing view's does.
 * Takes the membership the READ GATE resolved, never an id from input. Writes
 * nothing. Null when the membership does not exist.
 */
export async function loadMyMentorRequests(
	membershipId: string,
): Promise<MyMentorRequests | null> {
	const [me] = await db
		.select({ clubId: members.clubId })
		.from(members)
		.where(eq(members.id, membershipId))
		.limit(1);
	if (!me) return null;
	const cc = await loadClubDefaultCountryCode(me.clubId);
	const [outgoingRows, incomingRows] = await Promise.all([
		db
			.select({
				id: mentorshipRequests.id,
				status: mentorshipRequests.status,
				focus: mentorshipRequests.focus,
				focusOther: mentorshipRequests.focusOther,
				createdAt: mentorshipRequests.createdAt,
				mentorId: mentorM.id,
				mentorName: mentorM.name,
				mentorStatus: mentorM.status,
				person: {
					email: mentorPersonR.email,
					phone: mentorPersonR.phone,
					preferredContact: mentorPersonR.preferredContact,
				},
			})
			.from(mentorshipRequests)
			.innerJoin(mentorM, eq(mentorM.id, mentorshipRequests.mentorMemberId))
			.innerJoin(mentorPersonR, eq(mentorPersonR.id, mentorM.personId))
			.where(eq(mentorshipRequests.menteeMemberId, membershipId))
			// A pending row first: membership collapse can leave a newer withdrawn
			// one, and the mentee must see (and be able to withdraw) the pending
			// request that holds their slot.
			.orderBy(
				sql`(${mentorshipRequests.status} = 'pending') desc`,
				sql`${mentorshipRequests.createdAt} desc`,
				sql`${mentorshipRequests.id} desc`,
			)
			.limit(1),
		db
			.select({
				id: mentorshipRequests.id,
				focus: mentorshipRequests.focus,
				focusOther: mentorshipRequests.focusOther,
				createdAt: mentorshipRequests.createdAt,
				menteeId: menteeM.id,
				menteeName: menteeM.name,
				person: {
					email: menteePersonR.email,
					phone: menteePersonR.phone,
					preferredContact: menteePersonR.preferredContact,
				},
			})
			.from(mentorshipRequests)
			.innerJoin(menteeM, eq(menteeM.id, mentorshipRequests.menteeMemberId))
			.innerJoin(mentorM, eq(mentorM.id, mentorshipRequests.mentorMemberId))
			.innerJoin(menteePersonR, eq(menteePersonR.id, menteeM.personId))
			.where(
				and(
					eq(mentorshipRequests.mentorMemberId, membershipId),
					eq(mentorshipRequests.status, "pending"),
					eq(menteeM.status, "active"),
					eq(mentorM.status, "active"),
				),
			)
			.orderBy(asc(mentorshipRequests.createdAt), asc(mentorshipRequests.id)),
	]);
	const [o] = outgoingRows;
	return {
		outgoing: o
			? {
					id: o.id,
					status: o.status,
					focus: o.focus,
					focusOther: o.focusOther,
					createdAt: o.createdAt,
					// A mentor who is no longer active (left the club, #1342) keeps
					// their name on the request the mentee can still withdraw, but
					// their contact is not handed to a former colleague's mentee.
					mentor: requestParty(
						{ id: o.mentorId, name: o.mentorName },
						o.mentorStatus === "active"
							? o.person
							: { email: null, phone: null, preferredContact: null },
						cc,
					),
				}
			: null,
		incoming: incomingRows.map((r) => ({
			id: r.id,
			focus: r.focus,
			focusOther: r.focusOther,
			createdAt: r.createdAt,
			mentee: requestParty(
				{ id: r.menteeId, name: r.menteeName },
				r.person,
				cc,
			),
		})),
	};
}

/**
 * Every pending request in the club, oldest first, for an admin to answer on
 * the mentor's behalf (#1209). One whose party is no longer active is kept and
 * flagged (`partyInactive`): accept is refused for it, so the admin must be able
 * to see and decline it rather than leave it holding the mentee's one slot.
 * Names only. Writes nothing.
 */
export async function loadClubPendingMentorRequests(
	clubId: string,
): Promise<ClubPendingMentorRequest[]> {
	const rows = await db
		.select({
			id: mentorshipRequests.id,
			focus: mentorshipRequests.focus,
			focusOther: mentorshipRequests.focusOther,
			createdAt: mentorshipRequests.createdAt,
			mentorId: mentorM.id,
			mentorName: mentorM.name,
			menteeId: menteeM.id,
			menteeName: menteeM.name,
			mentorStatus: mentorM.status,
			menteeStatus: menteeM.status,
		})
		.from(mentorshipRequests)
		.innerJoin(mentorM, eq(mentorM.id, mentorshipRequests.mentorMemberId))
		.innerJoin(menteeM, eq(menteeM.id, mentorshipRequests.menteeMemberId))
		.where(
			and(
				eq(mentorshipRequests.clubId, clubId),
				eq(mentorshipRequests.status, "pending"),
			),
		)
		.orderBy(asc(mentorshipRequests.createdAt), asc(mentorshipRequests.id));
	return rows.map((r) => ({
		id: r.id,
		focus: r.focus,
		focusOther: r.focusOther,
		createdAt: r.createdAt,
		mentor: { id: r.mentorId, name: r.mentorName },
		mentee: { id: r.menteeId, name: r.menteeName },
		partyInactive: r.mentorStatus !== "active" || r.menteeStatus !== "active",
	}));
}
