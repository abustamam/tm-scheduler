/**
 * Resolving a signed-in user to their Person — deterministically, and to the
 * SAME Person every surface uses.
 *
 * `people.user_id` is not unique. ADR-0008 makes one human one Person, and #329
 * shipped dedupe-on-write plus a superadmin merge, but real duplicates predate
 * that and still exist in the wild (the merge is a manual, post-deploy step).
 * Every caller that did `const [p] = … where(eq(people.userId, id))` therefore
 * picked an ARBITRARY row — no ORDER BY, no LIMIT, whatever Postgres returned
 * first, which can differ between two queries in the same request.
 *
 * That was invisible until Pathways gave a person-level record something to
 * write. Found by QA on a dev database where one account had six linked Person
 * rows: declaring a path on the dashboard wrote it to a membership-less Person,
 * while the speech project picker read the Person behind the roster membership.
 * Same human, two records, no error — you set your path and the picker acted
 * like you hadn't.
 *
 * The roster membership is the tiebreak because every club-scoped surface
 * already resolves through `members.person_id`. Preferring the Person that
 * actually holds a membership makes the person-level surfaces agree with the
 * club-scoped ones instead of quietly diverging.
 *
 * This does NOT merge duplicates — that stays a deliberate superadmin action
 * (#329). It only makes the choice consistent and predictable.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";

/**
 * The canonical Person for a signed-in user, or null when the account has no
 * linked Person at all.
 *
 * Ordering: most roster memberships first (the identity the club sees), then
 * oldest, then id — fully deterministic, so two calls in one request can never
 * disagree.
 */
export async function resolveUserPersonId(
	userId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: people.id })
		.from(people)
		.leftJoin(members, eq(members.personId, people.id))
		.where(eq(people.userId, userId))
		.groupBy(people.id, people.createdAt)
		.orderBy(desc(sql`count(${members.id})`), people.createdAt, people.id)
		.limit(1);
	return row?.id ?? null;
}

/**
 * EVERY Person linked to this user.
 *
 * Self-checks ("is this member me?") must compare against all of them. With
 * duplicates, comparing a single arbitrary Person to `members.person_id` can
 * say "not you" about your own roster row — which pushes a member into the
 * admin gate for editing their own record, and reads as a permission error.
 */
export async function userPersonIds(userId: string): Promise<string[]> {
	const rows = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.userId, userId));
	return rows.map((r) => r.id);
}
