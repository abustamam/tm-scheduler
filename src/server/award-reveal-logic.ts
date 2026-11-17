/**
 * The in-room award reveal's read (#1654), split out from `award-reveal.ts` so
 * the db never reaches a client bundle.
 *
 * SESSION-GATED, unlike the Present route that calls it: winners are
 * members-only (`getMinutes` returns them only to signed-in active members), and
 * guest and write-in names must never enter the public payload. So: no session,
 * an unreadable (archived) club, or neither an active membership nor an active
 * impersonation of THIS club (either mode) gets `null`. No `completed` gate:
 * the reveal happens before the meeting is closed.
 */
import { AWARD_CATEGORIES } from "#/lib/award-categories";
import { isReadableClub } from "./club-readable-logic";
import { getActiveMembership } from "./guards";
import { getActiveImpersonation } from "./impersonation-logic";
import { getMeetingClubId, selectAwardWinners } from "./minutes-logic";

export type AwardReveal = {
	winners: {
		category: (typeof AWARD_CATEGORIES)[number];
		name: string;
	}[];
} | null;

export async function loadAwardReveal(
	meetingId: string,
	sessionUserId: string | null,
): Promise<AwardReveal> {
	if (!sessionUserId) return null;
	const clubId = await getMeetingClubId(meetingId);
	if (!(await isReadableClub(clubId))) return null;
	const membership = await getActiveMembership(sessionUserId, clubId);
	if (!membership && !(await getActiveImpersonation(sessionUserId, clubId))) {
		return null;
	}
	const rows = await selectAwardWinners(meetingId);
	const byCategory = new Map(rows.map((r) => [r.category, r.name]));
	const winners: NonNullable<AwardReveal>["winners"] = [];
	for (const category of AWARD_CATEGORIES) {
		const name = byCategory.get(category)?.trim();
		if (name) winners.push({ category, name });
	}
	return { winners };
}
