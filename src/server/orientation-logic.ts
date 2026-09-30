// New-member orientation (#940): the db half. Split out from the
// `createServerFn` wrappers in `orientation.ts` so it is directly
// integration-testable and its `db` import never reaches the client bundle
// (see the header of `members-logic.ts`). What counts as DONE is decided in
// `#/lib/orientation` (pure); this file only loads the facts and writes the
// three columns.
//
// Two kinds of write, two authorization shapes:
//  - The member's OWN writes (Base Camp self-tick, "I'm all set") resolve the
//    target row FROM THE SESSION, never from input: `ownMembershipId` is the
//    caller's membership in the club, and the input schemas are `.strict()`
//    with no member id at all, so there is nothing to point at someone else's
//    row. A memberless read-write impersonation session is refused: it has no
//    orientation of its own, and ticking a member's box for them is exactly
//    the unverifiable report the checklist avoids.
//  - "Start orientation" is an admin write about ANOTHER person. Its caller
//    (`startOrientation` in `orientation.ts`) gates on
//    `requireClubRole(…, ["admin"])`; this function checks the target
//    membership belongs to that club.
//
// READS NEVER WRITE. The dashboard read admits a read-only impersonation
// session (#1043's review found a GET seeding rows under one), so nothing
// here inserts or updates on the read path.
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	meetings,
	members,
	mentorships,
	pathEnrollments,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	type OrientationFacts,
	type OrientationPairingFact,
	type OrientationSlotFact,
	type OrientationView,
	orientationView,
} from "#/lib/orientation";
import { coalesceToE164 } from "#/lib/phone";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { requireMembership } from "./guards";

/** The mentor's membership row, joined onto a mentorship (#939). */
const mentor = alias(members, "mentor");

export const ORIENTATION_NOT_YOURS_MESSAGE =
	"Only the member can tick their own orientation checklist.";
export const ORIENTATION_MEMBER_NOT_FOUND_MESSAGE =
	"Member not found in this club.";
export const ORIENTATION_MEMBER_INACTIVE_MESSAGE =
	"That member is inactive — reactivate them first.";

const clubId = z.string().uuid();

/** Self-writes carry the club and nothing that names a member. */
export const setBasecampSetupSchema = z
	.object({ clubId, done: z.boolean() })
	.strict();
export const dismissOrientationSchema = z.object({ clubId }).strict();
export const startOrientationSchema = z
	.object({ clubId, memberId: z.string().uuid() })
	.strict();

/**
 * The caller's OWN membership id in the club: the only row a self-write may
 * touch. `requireMembership` refuses a non-member, an inactive member and an
 * archived club, and admits a read-write impersonator as a memberless actor
 * (`id: null`), which is refused here.
 */
export async function ownMembershipId(
	userId: string,
	club: string,
): Promise<string> {
	const membership = await requireMembership(userId, club);
	if (membership.id === null) throw new Error(ORIENTATION_NOT_YOURS_MESSAGE);
	return membership.id;
}

/**
 * The facts `orientationView` derives from, for one membership, or null when
 * the membership does not exist. Reads only. A one-id call to
 * `loadOrientationFactsForMembers`, so the member's own checklist and the VPE
 * roster (#942) are loaded by the same code and cannot drift.
 */
export async function loadOrientationFacts(
	membershipId: string,
): Promise<OrientationFacts | null> {
	const facts = await loadOrientationFactsForMembers([membershipId]);
	return facts.get(membershipId) ?? null;
}

/** Deterministic order for the DISTINCT slot facts, whatever the plan does. */
function compareSlotFacts(a: OrientationSlotFact, b: OrientationSlotFact) {
	if (a.isSpeakerRole !== b.isSpeakerRole) return a.isSpeakerRole ? -1 : 1;
	return a.meetingStatus.localeCompare(b.meetingStatus);
}

/**
 * The same facts for MANY memberships, keyed by membership id, in a fixed
 * number of queries whatever the count (#942): the members, then paths, slots
 * and pairings with `inArray`, and each distinct club's country code once. An
 * id that matches no membership is absent from the map. Reads only.
 */
export async function loadOrientationFactsForMembers(
	membershipIds: readonly string[],
): Promise<Map<string, OrientationFacts>> {
	const out = new Map<string, OrientationFacts>();
	const ids = [...new Set(membershipIds)];
	if (ids.length === 0) return out;

	const rows = await db
		.select({
			id: members.id,
			personId: members.personId,
			clubId: members.clubId,
			status: members.status,
			startedAt: members.orientationStartedAt,
			dismissedAt: members.orientationDismissedAt,
			basecampSetupAt: members.basecampSetupAt,
		})
		.from(members)
		.where(inArray(members.id, ids));
	if (rows.length === 0) return out;

	const personIds = [...new Set(rows.map((r) => r.personId))];
	const clubIds = [...new Set(rows.map((r) => r.clubId))];

	const [paths, slots, pairings, countryCodes] = await Promise.all([
		db
			.select({ personId: pathEnrollments.personId, n: count() })
			.from(pathEnrollments)
			.where(
				and(
					inArray(pathEnrollments.personId, personIds),
					isNull(pathEnrollments.archivedAt),
				),
			)
			.groupBy(pathEnrollments.personId),
		// DISTINCT on the two facts the derivation reads, per member, so a
		// long-standing member's slot history is at most six rows here, not
		// hundreds.
		db
			.selectDistinct({
				memberId: roleSlots.assignedMemberId,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				meetingStatus: meetings.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(inArray(roleSlots.assignedMemberId, ids)),
		// "Get a mentor" (#939): every pairing with one of these memberships as
		// MENTEE, active or ended; `#/lib/orientation` decides which one counts.
		// The mentor's contact is the same the mentee could already read on the
		// mentor's member page (`getMemberProfile`, club members only).
		db
			.select({
				menteeMemberId: mentorships.menteeMemberId,
				focus: mentorships.focus,
				endedAt: mentorships.endedAt,
				mentorName: mentor.name,
				mentorEmail: mentor.email,
				mentorPhone: mentor.phone,
			})
			.from(mentorships)
			.innerJoin(mentor, eq(mentor.id, mentorships.mentorMemberId))
			// A pairing counts only while BOTH parties are active
			// (`mentorship-logic.ts`); an inactive mentor's pairing is dormant
			// and does not tick "Get a mentor". The mentee's own status is
			// checked per row below.
			.where(
				and(
					inArray(mentorships.menteeMemberId, ids),
					eq(mentor.status, "active"),
				),
			)
			.orderBy(asc(mentorships.startedAt), asc(mentorships.id)),
		Promise.all(
			clubIds.map(
				async (id) => [id, await loadClubDefaultCountryCode(id)] as const,
			),
		),
	]);

	const pathCount = new Map(paths.map((p) => [p.personId, p.n]));
	const cc = new Map(countryCodes);
	const slotsBy = new Map<string, OrientationSlotFact[]>();
	for (const { memberId, ...slot } of slots) {
		if (!memberId) continue;
		const list = slotsBy.get(memberId) ?? [];
		list.push(slot);
		slotsBy.set(memberId, list);
	}
	const pairingsBy = new Map<string, OrientationPairingFact[]>();
	for (const { menteeMemberId, ...p } of pairings) {
		const list = pairingsBy.get(menteeMemberId) ?? [];
		list.push(p);
		pairingsBy.set(menteeMemberId, list);
	}

	for (const row of rows) {
		const code = cc.get(row.clubId);
		out.set(row.id, {
			startedAt: row.startedAt,
			dismissedAt: row.dismissedAt,
			basecampSetupAt: row.basecampSetupAt,
			activePathCount: pathCount.get(row.personId) ?? 0,
			slots: (slotsBy.get(row.id) ?? []).sort(compareSlotFacts),
			menteePairings: (row.status === "active"
				? (pairingsBy.get(row.id) ?? [])
				: []
			).map((p) => ({
				...p,
				mentorPhone: coalesceToE164(p.mentorPhone, code),
			})),
		});
	}
	return out;
}

/** The checklist for one membership, or null when it does not exist. */
export async function getOrientation(
	membershipId: string,
): Promise<OrientationView | null> {
	const facts = await loadOrientationFacts(membershipId);
	return facts ? orientationView(facts) : null;
}

/**
 * The checklist for a membership named by an admin, scoped to the club: a
 * member of another club answers null rather than leaking their progress.
 */
export async function getMemberOrientation(input: {
	clubId: string;
	memberId: string;
}): Promise<OrientationView | null> {
	const [row] = await db
		.select({ id: members.id })
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		)
		.limit(1);
	return row ? getOrientation(row.id) : null;
}

/** Tick or untick the Base Camp item on the caller's OWN membership. */
export async function setMyBasecampSetup(input: {
	userId: string;
	clubId: string;
	done: boolean;
}): Promise<OrientationView | null> {
	const id = await ownMembershipId(input.userId, input.clubId);
	await db
		.update(members)
		.set({ basecampSetupAt: input.done ? new Date() : null })
		.where(eq(members.id, id));
	return getOrientation(id);
}

/** "I'm all set": hide the caller's OWN checklist for good. */
export async function dismissMyOrientation(input: {
	userId: string;
	clubId: string;
}): Promise<OrientationView | null> {
	const id = await ownMembershipId(input.userId, input.clubId);
	await db
		.update(members)
		.set({ orientationDismissedAt: new Date() })
		.where(and(eq(members.id, id), isNull(members.orientationDismissedAt)));
	return getOrientation(id);
}

/**
 * Put a member into orientation (an admin's write; the caller gates it). Also
 * clears a previous dismissal, so starting it again actually shows it. Leaves
 * the Base Camp tick alone: that is the member's own report.
 *
 * Refuses an INACTIVE membership server-side: a lapsed member is hidden from
 * every roster surface and has no dashboard to show a checklist on. Logs a
 * `member_edit` like the other admin member writes (`members-logic.ts`);
 * `logActivity` stamps `impersonated_by` under a read-write impersonation.
 */
export async function startOrientation(input: {
	clubId: string;
	memberId: string;
	actorMemberId: string | null;
}): Promise<OrientationView | null> {
	await db.transaction(async (tx) => {
		const [current] = await tx
			.select({
				status: members.status,
				startedAt: members.orientationStartedAt,
				dismissedAt: members.orientationDismissedAt,
			})
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			.for("update")
			.limit(1);
		if (!current) throw new Error(ORIENTATION_MEMBER_NOT_FOUND_MESSAGE);
		if (current.status !== "active") {
			throw new Error(ORIENTATION_MEMBER_INACTIVE_MESSAGE);
		}
		const startedAt = new Date();
		await tx
			.update(members)
			.set({ orientationStartedAt: startedAt, orientationDismissedAt: null })
			.where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				orientation: "started",
				before: {
					orientationStartedAt: current.startedAt,
					orientationDismissedAt: current.dismissedAt,
				},
				after: {
					orientationStartedAt: startedAt,
					orientationDismissedAt: null,
				},
			},
		});
	});
	return getOrientation(input.memberId);
}
