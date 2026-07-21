// First-admin setup-checklist completion data (#265). Derives, purely from
// real data, whether a club still looks "new" and which of the guided
// checklist's items are already done — never a stored step flag (a dismissal
// is the only client-local exception, kept in localStorage, see
// `#/lib/onboarding-checklist`). Split from the createServerFn wrapper
// (`onboarding-checklist.ts`, imported by client route files) so `#/db` never
// leaks into the client bundle — see `members-logic.ts` and
// `server-modules.guard.test.ts`.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	members,
	officerTerms,
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
	hasRecurrence: boolean;
	hasMeeting: boolean;
	hasOfficerTerm: boolean;
	/** Show the checklist at all: the club has no meetings yet, OR its roster
	 *  is still thin (< CHECKLIST_MEMBER_THRESHOLD active members). Once BOTH
	 *  grow past the bar the club has "graduated" and the checklist stops
	 *  showing — independent of any per-admin localStorage dismissal. */
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
	const hasMeeting = (meetingCountRow[0]?.count ?? 0) > 0;
	const hasEnoughMembers = memberCount >= CHECKLIST_MEMBER_THRESHOLD;

	return {
		clubSlug: club.slug,
		clubDetailsComplete: Boolean(
			club.name?.trim() &&
				club.clubNumber?.trim() &&
				club.meetingSchedule?.trim(),
		),
		memberCount,
		hasEnoughMembers,
		hasRecurrence: recurrenceRow.length > 0,
		hasMeeting,
		hasOfficerTerm: officerTermRow.length > 0,
		isNewClub: !hasMeeting || !hasEnoughMembers,
	};
}
