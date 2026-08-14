/**
 * THE archive gate for PUBLIC, no-session club reads (ADR-0016 / #186, #544).
 *
 * Soft-archiving (`clubs.archived_at`) is the takedown lever: ADR-0016 makes it
 * how a club is removed from the platform, and ADR-0024 leans on it for the
 * logo/brand takedown path. A read path that ignores it defeats the mechanism
 * it was built for.
 *
 * There are three enforcement points, and they are not interchangeable:
 *
 *   · AUTHED WRITES — `requireMembership` in `guards.ts` calls the private
 *     `assertClubNotArchived`, which THROWS. `requireClubRole` builds on it, so
 *     that one call covers every authed mutation.
 *   · AUTHED READS — `requireClubViewAccess` / `requireClubAdminView`, via
 *     `grantView` in `guards.ts`. This bullet used to claim the write choke
 *     point covered "every authed member/admin operation"; it does not, because
 *     the read gates resolve their own memberships and never call it. That
 *     sentence was load-bearing in the wrong direction — #560 is the same defect
 *     as #544 one layer in, and this file's prose is where a reader would have
 *     gone to check.
 *   · PUBLIC — this module. `createServerFn` endpoints are addressable directly
 *     without a session, so a route-level guard (the `/club/$clubId` shell's
 *     `beforeLoad` → `resolveClubOrRedirect`) is a guard on the CALLER, not on
 *     the data. Every public club reader must gate here on its own.
 *
 * It lives in its own module — rather than in `club-logo-logic.ts`, where
 * `isReadableClub` was born (#495) — precisely because that home is why #544
 * happened: two public readers added later (`getPublicClubRoles` in #341,
 * `getPublicClubProfile` in #318) each re-implemented a bare
 * `where(eq(clubs.id, clubId))` and neither author thought to look inside a
 * LOGO module for the club-wide archive check. A gate nobody can find is a gate
 * nobody uses.
 *
 * Callers return their own NOT-FOUND shape (`null` for a row, `[]` for a list)
 * rather than throwing, so an archived club is indistinguishable from one that
 * never existed — the same answer `resolveClubOrRedirect` gives in-app, and no
 * new error handling at any call site.
 *
 * The `-logic` suffix is load-bearing, not decoration. `server-modules.guard.test.ts`
 * exempts `*-logic.ts` outright and otherwise skips any module whose text lacks
 * the string `createServerFn` — which this file's prose above necessarily
 * contains, since explaining the gate means naming what it defends against.
 * Reading raw is deliberate there (a comment can only ADD a false offender), so
 * without the suffix this module's own doc comment would fail that guard. The
 * suffix is also honest: this is never-client-imported db logic, exactly what
 * the convention names.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, members } from "#/db/schema";
import { isClubArchived } from "#/lib/club-archive";

/** Matches `clubs-logic.ts`'s `UUID_RE` — comparing a non-UUID string against a
 *  `uuid` column makes Postgres throw ("invalid input syntax for type uuid")
 *  instead of returning zero rows, which would surface as a 500 instead of the
 *  404 an unknown/malformed club id should produce. */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a club may be served on a PUBLIC, unauthenticated read path: it
 * exists, its id is well-formed, and it is not soft-archived.
 *
 * False for an unknown club as well as an archived one, on purpose — the two
 * are the same answer to an anonymous caller, and collapsing them here means a
 * caller cannot accidentally distinguish them.
 */
export async function isReadableClub(clubId: string): Promise<boolean> {
	if (!UUID_RE.test(clubId)) return false;
	const [club] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return Boolean(club) && !isClubArchived(club);
}

/**
 * {@link isReadableClub} for a reader keyed by MEETING rather than club — the
 * ballot surfaces (#510), which take a bare `meetingId` and never see a club id.
 *
 * One round trip: the club is resolved through the meeting's own FK, so a
 * caller cannot pass a meeting from one club and a club id from another.
 * False when the meeting does not exist, matching the not-found collapse above.
 */
export async function isReadableClubForMeeting(
	meetingId: string,
): Promise<boolean> {
	if (!UUID_RE.test(meetingId)) return false;
	const [row] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	return Boolean(row) && !isClubArchived(row);
}

/**
 * {@link isReadableClub} for a reader keyed by MEMBER — `listMemberCommitments`
 * and `getMemberPathways`, which take a roster member id and never see a club id.
 *
 * Resolved through the member's own `club_id` FK for the same reason as the
 * meeting variant: the caller cannot pair one club's member with another club's
 * id. False for an unknown member, collapsing not-found the same way.
 */
export async function isReadableClubForMember(
	memberId: string,
): Promise<boolean> {
	if (!UUID_RE.test(memberId)) return false;
	const [row] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(members)
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.where(eq(members.id, memberId))
		.limit(1);
	return Boolean(row) && !isClubArchived(row);
}
