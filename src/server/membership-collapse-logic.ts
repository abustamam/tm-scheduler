// Membership-collapse primitive: merge TWO memberships OF THE SAME CLUB into a
// keeper, re-pointing every membership-scoped FK and deleting the absorbed
// `members` row. Shared by the within-club member merge (applyMemberMerge) and
// the cross-club Person merge (mergePeople) — both funnel through here so the
// re-point set stays in ONE place and can never drift.
//
// SCOPE: membership-level only. It deliberately does NOT touch `people` rows,
// `speeches`, or `path_enrollments` (those are Person-scoped — mergePeople owns
// them), and it does NOT log activity or enforce caller policy (e.g. "don't
// absorb a signed-in account") — those are the caller's job.
//
// This lives in a `*-logic.ts` (never client-imported) so its `#/db` import
// never leaks `pg` → `Buffer` into the browser bundle. See members-logic.ts.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "#/db";
import {
	activityLog,
	guests,
	meetingAttendance,
	meetingAwards,
	memberAvailability,
	memberDues,
	members,
	notifications,
	officerTerms,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { earliestDate } from "#/lib/person-identity";

/** A drizzle transaction handle (the arg the `db.transaction` callback gets). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Collapse the `absorbedId` membership into `keeperId` (both must belong to
 * `clubId`), inside the caller's transaction. Re-points all ten membership-
 * scoped foreign keys to the keeper — dropping the absorbed row on each
 * uniqueness collision so a re-point can never raise a unique-violation — then
 * reconciles the surviving keeper row and deletes the absorbed `members` row.
 *
 * Fixes a latent data-loss bug in the old merge: `officer_terms` and
 * `member_dues` (both `ON DELETE CASCADE` on `members`) are RE-POINTED here, so
 * deleting the absorbed row no longer cascade-destroys its offices and dues.
 *
 * No-op when `keeperId === absorbedId`. Throws if either membership is not in
 * `clubId`.
 */
export async function collapseMemberships(
	tx: Tx,
	clubId: string,
	keeperId: string,
	absorbedId: string,
): Promise<void> {
	if (keeperId === absorbedId) return;

	const rows = await tx
		.select()
		.from(members)
		.where(
			and(
				eq(members.clubId, clubId),
				inArray(members.id, [keeperId, absorbedId]),
			),
		);
	const keeper = rows.find((m) => m.id === keeperId);
	const absorbed = rows.find((m) => m.id === absorbedId);
	if (!keeper || !absorbed) {
		throw new Error("Both memberships must be in this club.");
	}

	// --- Reconcile the surviving keeper row --------------------------------
	// club_role: higher wins (admin > member). status: active if EITHER is
	// active. joined_at: earliest known. email/phone: keeper's, filling a null
	// from the absorbed. (name is left as the keeper's.)
	await tx
		.update(members)
		.set({
			clubRole:
				keeper.clubRole === "admin" || absorbed.clubRole === "admin"
					? "admin"
					: "member",
			status:
				keeper.status === "active" || absorbed.status === "active"
					? "active"
					: "inactive",
			joinedAt: earliestDate(keeper.joinedAt, absorbed.joinedAt),
			email: keeper.email ?? absorbed.email,
			phone: keeper.phone ?? absorbed.phone,
		})
		.where(eq(members.id, keeperId));

	// --- Re-point the ten membership FKs (absorbed → keeper) ---------------
	// Pattern for the unique-constrained tables: DELETE the absorbed rows that
	// would collide with an existing keeper row FIRST, then re-point the rest.

	// 1. officer_terms.membership_id — no unique on the table, so re-point all;
	//    then keep at most ONE OPEN term per position (earliest term_start
	//    wins, unknown start last, id as the deterministic tie-break). Closed
	//    terms (term_end set) are history and never deduped.
	await tx
		.update(officerTerms)
		.set({ membershipId: keeperId })
		.where(eq(officerTerms.membershipId, absorbedId));
	await tx.execute(sql`
		DELETE FROM officer_terms WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY position
					ORDER BY term_start ASC NULLS LAST, id ASC
				) AS rn
				FROM officer_terms
				WHERE membership_id = ${keeperId} AND term_end IS NULL
			) ranked
			WHERE ranked.rn > 1
		)`);

	// 2. member_dues.membership_id — unique (membership, period). Drop the
	//    absorbed rows for a period the keeper already has, then re-point.
	await tx.execute(sql`
		DELETE FROM member_dues
		WHERE membership_id = ${absorbedId}
			AND dues_period_id IN (
				SELECT dues_period_id FROM member_dues WHERE membership_id = ${keeperId}
			)`);
	await tx
		.update(memberDues)
		.set({ membershipId: keeperId })
		.where(eq(memberDues.membershipId, absorbedId));

	// 3. member_availability.member_id — unique (member, meeting). Drop the
	//    absorbed dup for a meeting the keeper already covers, then re-point.
	await tx.execute(sql`
		DELETE FROM member_availability
		WHERE member_id = ${absorbedId}
			AND meeting_id IN (
				SELECT meeting_id FROM member_availability WHERE member_id = ${keeperId}
			)`);
	await tx
		.update(memberAvailability)
		.set({ memberId: keeperId })
		.where(eq(memberAvailability.memberId, absorbedId));

	// 4. meeting_attendance.member_id — unique (meeting, member). Drop the
	//    absorbed dup where the keeper is already recorded, then re-point.
	await tx.execute(sql`
		DELETE FROM meeting_attendance
		WHERE member_id = ${absorbedId}
			AND meeting_id IN (
				SELECT meeting_id FROM meeting_attendance WHERE member_id = ${keeperId}
			)`);
	await tx
		.update(meetingAttendance)
		.set({ memberId: keeperId })
		.where(eq(meetingAttendance.memberId, absorbedId));

	// 5. meeting_awards.member_id — unique is (meeting, category), which does
	//    NOT include member_id, so a plain re-point can't collide (two members
	//    can never both hold one meeting+category award). The defensive DELETE
	//    below keys on (meeting, category) purely as a belt-and-braces guard.
	await tx.execute(sql`
		DELETE FROM meeting_awards
		WHERE member_id = ${absorbedId}
			AND (meeting_id, category) IN (
				SELECT meeting_id, category FROM meeting_awards WHERE member_id = ${keeperId}
			)`);
	await tx
		.update(meetingAwards)
		.set({ memberId: keeperId })
		.where(eq(meetingAwards.memberId, absorbedId));

	// 6. notifications.assigned_member_id — partial unique (slot, member) where
	//    member is not null. Drop the absorbed dup for a slot the keeper is
	//    already queued on, then re-point.
	await tx.execute(sql`
		DELETE FROM notifications
		WHERE assigned_member_id = ${absorbedId}
			AND slot_id IN (
				SELECT slot_id FROM notifications WHERE assigned_member_id = ${keeperId}
			)`);
	await tx
		.update(notifications)
		.set({ assignedMemberId: keeperId })
		.where(eq(notifications.assignedMemberId, absorbedId));

	// 7. role_slots.assigned_member_id — no member-unique; re-point all.
	await tx
		.update(roleSlots)
		.set({ assignedMemberId: keeperId })
		.where(eq(roleSlots.assignedMemberId, absorbedId));

	// 8. table_topics_speakers.member_id — no member-unique; re-point all.
	await tx
		.update(tableTopicsSpeakers)
		.set({ memberId: keeperId })
		.where(eq(tableTopicsSpeakers.memberId, absorbedId));

	// 9. guests.converted_membership_id — no member-unique; re-point all so the
	//    "guest became this membership" history survives the collapse.
	await tx
		.update(guests)
		.set({ convertedMembershipId: keeperId })
		.where(eq(guests.convertedMembershipId, absorbedId));

	// 10. activity_log — re-point the actor column AND the jsonb subject refs
	//     (detail.memberId / detail.fromMemberId, scoped to this club), then
	//     drop the absorbed member's OWN member-target rows (member_add etc.),
	//     mirroring the existing merge so we don't accumulate dangling history.
	await tx
		.update(activityLog)
		.set({ actorMemberId: keeperId })
		.where(eq(activityLog.actorMemberId, absorbedId));
	await tx.execute(sql`
		UPDATE activity_log
		SET detail = jsonb_set(detail, '{memberId}', ${`"${keeperId}"`}::jsonb)
		WHERE club_id = ${clubId} AND detail->>'memberId' = ${absorbedId}`);
	await tx.execute(sql`
		UPDATE activity_log
		SET detail = jsonb_set(detail, '{fromMemberId}', ${`"${keeperId}"`}::jsonb)
		WHERE club_id = ${clubId} AND detail->>'fromMemberId' = ${absorbedId}`);
	await tx
		.delete(activityLog)
		.where(
			and(
				eq(activityLog.targetType, "member"),
				eq(activityLog.targetId, absorbedId),
			),
		);

	// --- Delete the now-empty absorbed membership --------------------------
	await tx.delete(members).where(eq(members.id, absorbedId));
}
