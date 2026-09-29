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
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import { members, mentorships } from "#/db/schema";
import {
	MENTORSHIP_FOCUS_OTHER_MAX,
	MENTORSHIP_FOCUSES,
	type MentorCandidate,
	type MentorshipFocus,
	orderMentorCandidates,
} from "#/lib/mentorship";
import { coalesceToE164 } from "#/lib/phone";
import { logActivity } from "./activity";
import { lockClubForWrite } from "./club-write-lock";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { requireMembership } from "./guards";
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
export const MENTORSHIP_NOT_YOURS_MESSAGE =
	"Only the member can change their own willing-to-mentor setting.";

const uuid = z.string().uuid();
const focus = z.enum(MENTORSHIP_FOCUSES).nullable();
const focusOther = z
	.string()
	.trim()
	.max(MENTORSHIP_FOCUS_OTHER_MAX)
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
/** The member's own flag: the club and the value, nothing that names a member. */
export const setWillingToMentorSchema = z
	.object({ clubId: uuid, willing: z.boolean() })
	.strict();

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The other party of a pairing, as a party or an admin sees them. */
export interface MentorshipParty {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
}

export interface MentorshipRow {
	id: string;
	focus: MentorshipFocus | null;
	focusOther: string | null;
	startedAt: Date;
	/** The OTHER party: the mentor in a mentee's list, the mentee in a mentor's. */
	member: MentorshipParty;
}

export interface MyMentorships {
	willingToMentor: boolean;
	/** Active pairings where the caller is the mentee. */
	mentors: MentorshipRow[];
	/** Active pairings where the caller is the mentor. */
	mentees: MentorshipRow[];
}

export interface MemberMentorships extends MyMentorships {
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

/** Set or clear "willing to mentor" on the caller's OWN membership. */
export async function setMyWillingToMentor(input: {
	userId: string;
	clubId: string;
	willing: boolean;
}): Promise<{ willingToMentor: boolean }> {
	const id = await ownMembershipId(input.userId, input.clubId);
	await db
		.update(members)
		.set({ willingToMentor: input.willing })
		.where(eq(members.id, id));
	return { willingToMentor: input.willing };
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

/** Pair a mentor with a mentee (an admin's write; the caller gates it). */
export async function createMentorship(input: {
	clubId: string;
	mentorMemberId: string;
	menteeMemberId: string;
	focus: MentorshipFocus | null;
	focusOther?: string | null;
	actorMemberId: string | null;
}): Promise<{ id: string }> {
	const focusOtherValue = normalizeFocusOther(input.focus, input.focusOther);
	try {
		return await db.transaction(async (tx) => {
			await lockClubForWrite(tx, input.clubId);
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
					focusOther: focusOtherValue,
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
					focusOther: focusOtherValue,
				},
			});
			return { id: row.id };
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
			const row = await lockActivePairing(tx, input.clubId, input.mentorshipId);
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
// Reads (never write)
// ---------------------------------------------------------------------------

const other = alias(members, "other_party");
const selfParty = alias(members, "self_party");

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
			otherEmail: other.email,
			otherPhone: other.phone,
		})
		.from(mentorships)
		.innerJoin(other, eq(other.id, otherCol))
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
		},
	}));
}

/**
 * The caller's own mentors and mentees (dashboard). Takes the membership the
 * READ GATE resolved, never an id from input. Null when it does not exist.
 */
export async function loadMyMentorships(
	membershipId: string,
): Promise<MyMentorships | null> {
	const [row] = await db
		.select({ clubId: members.clubId, willing: members.willingToMentor })
		.from(members)
		.where(eq(members.id, membershipId))
		.limit(1);
	if (!row) return null;
	const cc = await loadClubDefaultCountryCode(row.clubId);
	const [mentors, mentees] = await Promise.all([
		activePairingsFor(membershipId, "mentee", cc),
		activePairingsFor(membershipId, "mentor", cc),
	]);
	return { willingToMentor: row.willing, mentors, mentees };
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
	return { ...mine, candidates: orderMentorCandidates(pool, row.id) };
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
