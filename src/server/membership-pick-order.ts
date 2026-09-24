/**
 * The ONE ordering that decides which membership represents a login in a club
 * (#838). Four selectors resolve `people.user_id` → `members` and keep a single
 * row, and every one of them orders by what this module returns:
 *
 *   · `getMembership`        (`guards.ts`)              — route authorization
 *   · `resolveAdminGrant`    (`meeting-authz-logic.ts`) — agenda-write grant
 *   · `viewerMaySeeProgress` (`project-picker-logic.ts`) — Pathways progress gate
 *   · `selfMemberIdInClub`   (`progress-marks-logic.ts`) — mark ATTRIBUTION
 *
 * Until #838 each carried its own copy of the order, with comments saying the
 * copies must move together. Nothing made them: a change to one copy would have
 * let authorization and attribution name different memberships for one human.
 * Now there is nothing to keep in step.
 *
 * ## Why a pick needs an order at all
 *
 * `people.user_id` is not unique — ADR-0008 makes one human one Person, but
 * duplicates predate #329's dedupe-on-write and their merge is a manual
 * superadmin step — so one human can hold two `members` rows in the SAME club
 * through two Person rows (`people_user_idx` is a plain index). An unordered
 * single-row pick is then arbitrary, and can flip an answer between requests.
 *
 * ## The keys, in order (#471)
 *
 *   1. ACTIVE first — a lapsed membership must never out-rank a current one.
 *      This is load-bearing in `getMembership`, because `canManageClub` reads
 *      `clubRole` with no status check. It is NOT what refuses a lapsed admin in
 *      `resolveAdminGrant` or `viewerMaySeeProgress`: each carries its own
 *      `status === "active"` check, because key 1 only ranks rows that exist and
 *      a lapsed admin who is the ONLY membership still comes back first.
 *   2. ADMIN next — the human genuinely holds an admin membership here, so
 *      denying it because the other duplicate came back first is the bug. This
 *      grants nothing new: `people.user_id` is written only by
 *      `bindVerifiedPerson` (magic-link-verified email, under
 *      `isNull(people.userId)`) and by `mergePeople`'s keeper adoption, so every
 *      linked Person is the same human either way.
 *   3. Most OPEN OFFICER TERMS next — effective-admin (#202) is granted by
 *      `getOpenOfficerPositions(membership.id)`, which reads ONE membership, so
 *      the pick has to land on the row holding the term. A COUNT, and only open
 *      terms (`termEnd IS NULL`), which is why the join condition lives here too.
 *   4. Oldest (`created_at` ascending), then
 *   5. `members.id` ascending — a total order, so two queries on one snapshot
 *      can never disagree.
 *
 * "Cannot disagree" is per SNAPSHOT: two statements read two MVCC snapshots.
 * `getMembership` takes a `conn` so a locked re-check can pin its snapshot.
 *
 * ## What a caller must do
 *
 * Left-join `officerTerms` ON {@link membershipPickOpenTermJoin}, group by
 * `members.id` (plus any non-`members` column it selects), and
 * `.orderBy(...membershipPickOrder())`. Key 3 counts rows of that join; with any
 * other join condition it counts the wrong thing, and without the grouping the
 * count is not an aggregate at all.
 *
 * ## Why this module is safe to import from logic code
 *
 * It imports `drizzle-orm` and the schema's table objects and nothing else — no
 * `#/db` connection, no Better Auth, no request context, no server fn.
 * `project-picker-logic.ts` could not route through `guards.ts` for exactly that
 * reason (`guards.ts` imports Better Auth, and `slots-logic.ts` imports the
 * picker, so every suite mocking only `#/db` would hang), and it must be able to
 * import THIS. `membership-pick-order.test.ts` holds the import set.
 *
 * Functions rather than shared constants, so each query gets its own SQL
 * fragments rather than every builder holding one mutable object.
 */
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { members, officerTerms } from "#/db/schema";

/**
 * The `ON` condition for the `officerTerms` left join key 3 counts: this
 * membership's OPEN terms only. `officer_terms_open_idx` covers
 * (membership_id, term_end).
 */
export function membershipPickOpenTermJoin(): SQL {
	// `and()` of two defined conditions is never undefined; the fallback is for
	// the type only.
	return (
		and(
			eq(officerTerms.membershipId, members.id),
			isNull(officerTerms.termEnd),
		) ?? sql`false`
	);
}

/** The five ORDER BY keys, strongest membership first. Spread into `.orderBy`. */
export function membershipPickOrder(): [SQL, SQL, SQL, PgColumn, PgColumn] {
	return [
		sql`(${members.status} = 'active') desc`,
		sql`(${members.clubRole} = 'admin') desc`,
		desc(sql`count(${officerTerms.id})`),
		members.createdAt,
		members.id,
	];
}
