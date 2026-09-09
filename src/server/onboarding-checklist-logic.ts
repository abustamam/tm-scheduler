// First-admin setup-checklist completion data (#265). Derives, purely from
// real data, whether a club still looks "new" and which of the guided
// checklist's items are already done — never a stored step flag (a dismissal
// is the only client-local exception, kept in localStorage, see
// `#/lib/onboarding-checklist`). Split from the createServerFn wrapper
// (`onboarding-checklist.ts`, imported by client route files) so `#/db` never
// leaks into the client bundle — see `members-logic.ts` and
// `server-modules.guard.test.ts`.
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	members,
	officerTerms,
	people,
} from "#/db/schema";
import { CHECKLIST_MEMBER_THRESHOLD } from "#/lib/onboarding-checklist";

export interface OnboardingChecklistStatus {
	clubSlug: string;
	/** Name + club number are required at provisioning (createClubWithAdmin);
	 *  this additionally requires the free-text meeting-schedule field, so the
	 *  item only checks off once the admin has actually visited club settings
	 *  and confirmed the meeting day/time. */
	clubDetailsComplete: boolean;
	memberCount: number;
	hasEnoughMembers: boolean;
	/** Active members whose Person can already sign in or has been asked to:
	 *  `people.invited_at` set (an account invite went out) OR `people.user_id`
	 *  set (they already joined, which supersedes any invite — see
	 *  `#/lib/invite-state`). Counted over the SAME active-membership set as
	 *  `memberCount`, so the two are directly comparable. */
	invitedMemberCount: number;
	/** Enough of the roster has been invited to count as "the club has started":
	 *  `invitedMemberCount >= min(CHECKLIST_MEMBER_THRESHOLD, memberCount)`, so a
	 *  club smaller than the threshold clears it by inviting everyone rather than
	 *  by being permanently short. False on an empty roster. */
	hasInvitedMembers: boolean;
	hasRecurrence: boolean;
	hasMeeting: boolean;
	hasOfficerTerm: boolean;
	/** Show the checklist at all: the club has no meetings yet, OR its roster
	 *  is still thin (< CHECKLIST_MEMBER_THRESHOLD active members), OR nobody
	 *  has been invited yet. The club's core loop is members claiming roles and
	 *  nobody can claim until they can sign in, so a roster that was imported
	 *  but never invited is a club that has not started (#716). Once all three
	 *  clear, the club has "graduated" and the checklist stops showing —
	 *  independent of any per-admin localStorage dismissal. */
	isNewClub: boolean;
}

/** Setup-checklist status for one club. Throws when the club doesn't exist.
 *  The caller enforces the admin-only gate (see `onboarding-checklist.ts`). */
export async function getOnboardingChecklistStatus(
	clubId: string,
): Promise<OnboardingChecklistStatus> {
	const [
		clubRow,
		memberCountRow,
		invitedCountRow,
		recurrenceRow,
		meetingCountRow,
		officerTermRow,
	] = await Promise.all([
		db
			.select({
				slug: clubs.slug,
				name: clubs.name,
				clubNumber: clubs.clubNumber,
				meetingSchedule: clubs.meetingSchedule,
			})
			.from(clubs)
			.where(eq(clubs.id, clubId))
			.limit(1),
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.status, "active"))),
		// Invited OR joined, over the same active-membership set as the count
		// above. Both facts live on the Person (ADR-0008), which is why this
		// joins rather than reading the membership row — same pair
		// `inviteStateOf` reads for the roster's per-row badge.
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(
				and(
					eq(members.clubId, clubId),
					eq(members.status, "active"),
					or(isNotNull(people.invitedAt), isNotNull(people.userId)),
				),
			),
		db
			.select({ id: clubMeetingRecurrence.id })
			.from(clubMeetingRecurrence)
			.where(eq(clubMeetingRecurrence.clubId, clubId))
			.limit(1),
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(meetings)
			.where(eq(meetings.clubId, clubId)),
		db
			.select({ id: officerTerms.id })
			.from(officerTerms)
			.innerJoin(members, eq(members.id, officerTerms.membershipId))
			.where(and(eq(members.clubId, clubId), isNull(officerTerms.termEnd)))
			.limit(1),
	]);

	const club = clubRow[0];
	if (!club) throw new Error("Club not found.");

	const memberCount = memberCountRow[0]?.count ?? 0;
	const invitedMemberCount = invitedCountRow[0]?.count ?? 0;
	const hasMeeting = (meetingCountRow[0]?.count ?? 0) > 0;
	const hasEnoughMembers = memberCount >= CHECKLIST_MEMBER_THRESHOLD;
	// `min(threshold, memberCount)` so a club of 3 clears the row by inviting all
	// 3 — the bar is "everyone you have, up to the threshold", not a count a
	// small club can never reach. `memberCount > 0` keeps an empty roster from
	// clearing it vacuously (0 >= min(5, 0)).
	const hasInvitedMembers =
		memberCount > 0 &&
		invitedMemberCount >= Math.min(CHECKLIST_MEMBER_THRESHOLD, memberCount);

	return {
		clubSlug: club.slug,
		clubDetailsComplete: Boolean(
			club.name?.trim() &&
				club.clubNumber?.trim() &&
				club.meetingSchedule?.trim(),
		),
		memberCount,
		hasEnoughMembers,
		invitedMemberCount,
		hasInvitedMembers,
		hasRecurrence: recurrenceRow.length > 0,
		hasMeeting,
		hasOfficerTerm: officerTermRow.length > 0,
		isNewClub: !hasMeeting || !hasEnoughMembers || !hasInvitedMembers,
	};
}
