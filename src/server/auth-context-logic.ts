/**
 * Testable db logic behind `getAuthContext` (`auth-context.ts`).
 *
 * Two reasons this is its own module, both from CLAUDE.md's server-module split:
 * `auth-context.ts` is imported by the client layout, so a db-touching top-level
 * export there would drag `pg` → `Buffer` into the browser bundle; and a query
 * living inside a `createServerFn` handler is unreachable from vitest, which is
 * why the archive filter below could not otherwise be tested at all.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people } from "#/db/schema";

/**
 * How many of the user's active memberships are in a SOFT-ARCHIVED club.
 *
 * Exists only so the club-less shell can tell two situations apart that
 * `loadUserClubMemberships` collapses: an account genuinely not on any roster, and
 * a member whose club was taken down. Without it the second sees "You're not in a
 * club yet … this account isn't linked to a Toastmasters club on GavelUp yet",
 * which reads as an account problem and sends them to re-check their email address.
 *
 * A COUNT, deliberately — not the rows. Returning the club's name or number here
 * would hand back exactly the brand identity ADR-0024 leans on archiving to remove,
 * undoing the filter above. The screen says a club is unavailable; it does not say
 * which.
 *
 * Call only when the filtered list came back empty, so the ordinary path keeps
 * paying nothing for it.
 */
export async function countArchivedClubMemberships(
	userId: string,
): Promise<number> {
	const rows = await db
		.select({ clubId: clubs.id })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.where(
			and(
				eq(people.userId, userId),
				eq(members.status, "active"),
				isNotNull(clubs.archivedAt),
			),
		);
	return rows.length;
}

/**
 * The signed-in user's clubs for the switcher + route guards: their ACTIVE
 * memberships, resolved user → Person (`people.user_id`) → `members`
 * (ADR-0008 Phase B), with the club's display fields and their role in each.
 *
 * Excludes soft-archived clubs (#560). Archiving is the takedown lever
 * (ADR-0016 / ADR-0024), and leaving an archived club here had three effects, all
 * wrong: its NAME and club number — brand assets, which is what ADR-0024 leans on
 * archiving to take down — were served to every member in the shell's SSR
 * payload; the switcher offered a navigation dead-end, since the `/club/$clubId`
 * shell's `resolveClubOrRedirect` 404s on the same club; and it could become
 * `activeClubId`, which drives `ensureScheduleToppedUp` — a read-triggered WRITE
 * that would materialize new meetings into a club that had been taken down.
 *
 * NOTE the impersonation arm in `getAuthContext` does NOT filter on `archived_at`
 * — it looks the session's club up directly and pushes it in. That is a known gap,
 * not a carve-out: it was written while read-only impersonation was still going to
 * be exempt from the archive gate, and that exemption was DROPPED (`grantView`
 * rejects every arm — see `src/lib/club-archive.ts` for the canonical list). So an
 * archived club can still reach the switcher and become `activeClubId` while every
 * read behind it throws "archived". Reachable only by archiving a club during an
 * open session, since the console hides "View as this club" for an archived one.
 */
export async function loadUserClubMemberships(userId: string) {
	return db
		.select({
			memberId: members.id,
			clubId: clubs.id,
			name: clubs.name,
			clubNumber: clubs.clubNumber,
			clubRole: members.clubRole,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.where(
			and(
				eq(people.userId, userId),
				eq(members.status, "active"),
				isNull(clubs.archivedAt),
			),
		)
		.orderBy(asc(clubs.name));
}
