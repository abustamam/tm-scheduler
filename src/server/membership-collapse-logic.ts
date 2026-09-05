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
	clubActionItems,
	guests,
	meetingAttendance,
	meetingAttendancePlan,
	meetingAwards,
	meetingVoteSessions,
	meetingVotes,
	memberDues,
	members,
	notifications,
	officerTerms,
	officerTrainingRecords,
	projectCompletionMarks,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { earliestDate } from "#/lib/person-identity";

/** A drizzle transaction handle (the arg the `db.transaction` callback gets). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Collapse the `absorbedId` membership into `keeperId` (both must belong to
 * `clubId`), inside the caller's transaction. Re-points every membership-
 * scoped foreign key to the keeper — dropping the absorbed row on each
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
	// active. joined_at: earliest known. email/phone/preferred_name: keeper's,
	// filling a null from the absorbed. (name is left as the keeper's.)
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
			preferredName: keeper.preferredName ?? absorbed.preferredName,
		})
		.where(eq(members.id, keeperId));

	// --- Re-point every membership FK (absorbed → keeper) ------------------
	// This heading carried a COUNT that had been stale for several releases (it
	// read "the eleven membership FKs" above fourteen numbered steps), so the
	// number is gone: the authority is the FK drift-guard in
	// `membership-collapse-logic.integration.test.ts`, which compares the handled
	// set against the LIVE pg_constraint catalog and fails on any new FK to
	// `members`. That guard is what caught #531's own missing re-point.
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

	// 3. meeting_attendance_plan.member_id — unique (member, meeting) and ON
	//    DELETE CASCADE, so without this the absorbed membership's answers are
	//    destroyed by the merge rather than kept. On a collision the KEEPER's
	//    answer wins: it is the surviving identity, and the two rows are the
	//    same human answering twice, so there is no meaningful way to reconcile
	//    the statuses. (This one step replaced two: the two boolean tables it
	//    supersedes, dropped in this same PR, each needed the identical
	//    de-dup-then-re-point dance.)
	await tx.execute(sql`
		DELETE FROM meeting_attendance_plan
		WHERE member_id = ${absorbedId}
			AND meeting_id IN (
				SELECT meeting_id FROM meeting_attendance_plan WHERE member_id = ${keeperId}
			)`);
	await tx
		.update(meetingAttendancePlan)
		.set({ memberId: keeperId })
		.where(eq(meetingAttendancePlan.memberId, absorbedId));

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

	// 8b. club_action_items.owner_member_id (#529) — nullable, no member-unique
	//    constraint, so re-point all. Without this the absorbed membership's
	//    action items lose "whose job this was" on every merge. The FK
	//    drift-guard in this module's integration test is what caught the
	//    omission; the behavioural test beside it is what proves the fix runs.
	await tx
		.update(clubActionItems)
		.set({ ownerMemberId: keeperId })
		.where(eq(clubActionItems.ownerMemberId, absorbedId));

	// 9. project_completion_marks.marked_by_member_id — attribution only, and
	//    nullable. No member-unique constraint (the mark's uniqueness is on
	//    enrollment+project, which is person-level and so unaffected by a
	//    membership collapse), so re-point all: "who ticked this" survives.
	await tx
		.update(projectCompletionMarks)
		.set({ markedByMemberId: keeperId })
		.where(eq(projectCompletionMarks.markedByMemberId, absorbedId));

	// 10. guests.converted_membership_id — no member-unique; re-point all so the
	//    "guest became this membership" history survives the collapse.
	await tx
		.update(guests)
		.set({ convertedMembershipId: keeperId })
		.where(eq(guests.convertedMembershipId, absorbedId));

	// 11. activity_log — re-point the actor column AND the jsonb subject refs
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

	// 12. meeting_vote_sessions.opened_by_member_id (#510) — nullable attribution
	//     ("who opened this vote"). The table's unique is (meeting, category),
	//     which does not include the member, so a plain re-point cannot collide.
	await tx
		.update(meetingVoteSessions)
		.set({ openedByMemberId: keeperId })
		.where(eq(meetingVoteSessions.openedByMemberId, absorbedId));

	// 13. meeting_votes.voter_member_id (#510) — unique (session, voter). If ONE
	//     human held both memberships and each cast a ballot in the same session,
	//     re-pointing would violate that index. Drop the absorbed ballot and keep
	//     the keeper's, which is also the right answer on the merits: the whole
	//     point of the unique index is one vote per person, and a merge is the
	//     assertion that these two rows were always one person.
	await tx.execute(sql`
		DELETE FROM meeting_votes
		WHERE voter_member_id = ${absorbedId}
			AND session_id IN (
				SELECT session_id FROM meeting_votes WHERE voter_member_id = ${keeperId}
			)`);
	await tx
		.update(meetingVotes)
		.set({ voterMemberId: keeperId })
		.where(eq(meetingVotes.voterMemberId, absorbedId));

	// 14. meeting_votes.candidate_member_id (#510) — no member-unique on the
	//     candidate side (a session legitimately holds many ballots naming the
	//     same person), so re-point all. Ballots cast for either membership now
	//     count toward the one surviving person, which is what a merge means.
	await tx
		.update(meetingVotes)
		.set({ candidateMemberId: keeperId })
		.where(eq(meetingVotes.candidateMemberId, absorbedId));

	// 15. officer_training_records.membership_id (#531) — unique (membership,
	//     position, program_year, period), and ON DELETE CASCADE, so without a
	//     re-point the merge would DESTROY the absorbed membership's training
	//     credit and silently drop the club below goal 9's four-officer bar. The
	//     collision case is real rather than theoretical: a duplicate membership
	//     is usually the same human recorded twice, and whoever recorded the
	//     training may well have picked a different one of the two rows each
	//     period. Drop the absorbed row on a collision — the keeper's claim for
	//     that (office, year, period) already says the same thing, and the count
	//     is over distinct OFFICES, so dropping a duplicate claim for the surviving
	//     person loses nothing — and a merge can never LOWER the club's trained
	//     count, because the surviving rows still cover the same set of offices.
	//     (That was not true while the count was over people: this comment used
	//     to explain why the count legitimately dropped on merge. Counting
	//     offices removed the whole class.)
	//
	//     Fill the keeper's MISSING date from the absorbed row before dropping
	//     it. `trained_on` is nullable by design, so a plain "keeper wins" (the
	//     pattern borrowed from `meeting_attendance_plan`) silently downgraded a
	//     dated claim to "date not recorded". Unlike the attendance case there is
	//     a meaningful reconciliation here, because one side is ABSENT rather
	//     than contradictory — nothing is overwritten, only a null filled. The
	//     same argument applies to `recorded_by`, so the audit attribution is
	//     carried across too rather than being lost with the row; `coalesce`
	//     makes each column independent, so filling one never disturbs the other.
	await tx.execute(sql`
		UPDATE officer_training_records AS k
		SET trained_on = coalesce(k.trained_on, a.trained_on),
			recorded_by = coalesce(k.recorded_by, a.recorded_by)
		FROM officer_training_records AS a
		WHERE k.membership_id = ${keeperId}
			AND a.membership_id = ${absorbedId}
			AND k.position = a.position
			AND k.program_year = a.program_year
			AND k.period = a.period
			AND (
				(k.trained_on IS NULL AND a.trained_on IS NOT NULL)
				OR (k.recorded_by IS NULL AND a.recorded_by IS NOT NULL)
			)`);
	await tx.execute(sql`
		DELETE FROM officer_training_records
		WHERE membership_id = ${absorbedId}
			AND (position, program_year, period) IN (
				SELECT position, program_year, period
				FROM officer_training_records
				WHERE membership_id = ${keeperId}
			)`);
	await tx
		.update(officerTrainingRecords)
		.set({ membershipId: keeperId })
		.where(eq(officerTrainingRecords.membershipId, absorbedId));

	// --- Delete the now-empty absorbed membership --------------------------
	await tx.delete(members).where(eq(members.id, absorbedId));
}
