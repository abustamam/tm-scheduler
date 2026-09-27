import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, members } from "#/db/schema";
import { isClubArchived } from "#/lib/club-archive";
import { resolveWriteActorWithProof } from "./write-actor-logic";

/**
 * Who a signed-in phone votes as on this meeting's ballot (#962): the session
 * user's own ACTIVE member row in the meeting's club, or null.
 *
 * The rule is `resolveWriteActorWithProof`'s `proof: "session"` arm, called
 * exactly as `castVote`'s `sessionIsVoter` calls it (no claimed actor). So the
 * identity the ballot DISPLAYS and the one allowed to CHANGE a cast vote (#765)
 * come from one definition and cannot disagree. An impersonating superadmin
 * resolves to null here as there, and so votes as whoever they pick.
 *
 * Read-only by design, which is why this is not `getAuthContext`: no active-club
 * cookie, no schedule top-up, no club switch. A member whose active club is
 * another one resolves directly, because the club comes from the MEETING.
 *
 * Null (never a throw) for an unknown meeting and for an archived club: this
 * only decides whether the phone skips the name picker, and the ballot beside
 * it already collapses an archived club to "nothing open".
 */
export async function loadBallotSessionVoter(
	meetingId: string,
	sessionUserId: string,
): Promise<{ id: string; name: string } | null> {
	const [meeting] = await db
		.select({ clubId: meetings.clubId, archivedAt: clubs.archivedAt })
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting || isClubArchived(meeting)) return null;
	const actor = await resolveWriteActorWithProof({
		clubId: meeting.clubId,
		sessionUserId,
		claimedActorMemberId: null,
	});
	// With no claimed actor the asserted arm is unreachable, so this equals
	// `!actor` today. Kept as `sessionIsVoter`'s exact test so the two stay one
	// rule if that seam ever grows another arm.
	if (actor?.proof !== "session") return null;
	const [member] = await db
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(eq(members.id, actor.memberId))
		.limit(1);
	return member ?? null;
}
