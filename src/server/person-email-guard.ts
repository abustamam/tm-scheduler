// The ONE definition of who may write `people.email`, shared by every writer.
//
// `people.email` is the identity key. `linkPersonToUser` matches a verified
// sign-in against it EXCLUSIVELY, and it wins the `person.email ?? member.email`
// coalesce at `prepareMemberInvite` and `claimPersonForUser` — so whoever
// controls the value controls who the Person becomes, and `linkPersonToUser`
// will faithfully bind whatever it ends up saying. That is why the rule has to
// hold at every writer rather than at the one a bug was reported against:
// guarding a subset moves the takeover to the unguarded path instead of closing
// it, which this branch demonstrated twice before the surface was enumerated.
//
// The rule is a BLAST-RADIUS rule, deliberately not a value comparison:
//   - `user_id IS NULL` — once someone has signed in, the address is one they
//     PROVED they own via magic link. No club admin may move it.
//   - no membership outside the acting club — a Person is one row per human
//     across every club (ADR-0008), so writing it from club A silently re-keys
//     the identity club B relies on. With no other club on the row, the acting
//     club is the only stakeholder and owns the value outright.
//
// Do NOT replace the second rule with "does the Person still carry the address
// this membership seeded". `members.email` is state the same admin writes, so
// two consecutive saves satisfy any such comparison and one does in the common
// case — every path that creates a shared Person puts the identical address on
// both rows. A value comparison also cannot repair the state the original bug
// leaves behind, where the two rows have already diverged.
//
// Kept in its own module so the two logic modules that need it do not import
// each other, and so the predicate has one home rather than a comment asking
// future readers to keep copies in sync. `person-email-guard.guard.test.ts`
// asserts every call site emits identical SQL.
import { and, eq, isNull, ne, notExists, type SQL, sql } from "drizzle-orm";
import type { db } from "#/db";
import { members, people } from "#/db/schema";

/** Anything that can build a subquery — the `db` client or a transaction. The
 *  `notExists` argument is inlined into the enclosing WHERE as a subselect and
 *  is never executed on the handle it was built from, so either works. */
export type QueryHandle = Pick<typeof db, "select">;

/**
 * The WHERE predicate a `people.email` write must carry: this Person, with no
 * sign-in account, held by no club other than `clubId`.
 *
 * Fails CLOSED — a caller that forgets it writes unguarded, so new writers
 * belong in the guard test's call-site list, not just in review.
 */
export function personEmailWritable(
	handle: QueryHandle,
	personId: string,
	clubId: string,
): SQL {
	return and(
		eq(people.id, personId),
		isNull(people.userId),
		notExists(
			handle
				.select({ one: sql`1` })
				.from(members)
				.where(
					and(eq(members.personId, people.id), ne(members.clubId, clubId)),
				),
		),
	) as SQL;
}

/**
 * Whether any club OTHER than `clubId` holds this Person — the read-side half of
 * the same rule, for callers that must branch rather than filter.
 *
 * `claimPersonForUser` needs this: its `person.email ?? member.email` fallback
 * is what makes a NULL `people.email` dangerous rather than fail-safe, because
 * `members.email` is a column any officer of any of that Person's clubs
 * controls. For a Person more than one club holds, that fallback must not be
 * available at all.
 */
export async function personHeldByAnotherClub(
	handle: QueryHandle,
	personId: string,
	clubId: string,
): Promise<boolean> {
	const rows = await handle
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.personId, personId), ne(members.clubId, clubId)))
		.limit(1);
	return rows.length > 0;
}
