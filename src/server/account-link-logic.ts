// Account-linking DB logic (#188), split out from the Better-Auth config in
// `src/lib/auth.ts` so it is directly integration-testable. Kept in a
// `*-logic.ts` module (never client-imported) so its `#/db` → `pg` import stays
// server-side; see `members-logic.ts` for the pattern and the
// `server-modules.guard.test.ts` rationale.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { people, user } from "#/db/schema";

/**
 * Bind any unlinked roster `Person` to the signed-in account by CASE-INSENSITIVE
 * email match (ADR-0008 Phase B — the auth link lives on `people.user_id`).
 *
 * Called from the Better-Auth `session.create.after` hook, so it fires on EVERY
 * successful sign-in (magic-link is the only method), IDEMPOTENTLY:
 *   - Person provisioned BEFORE first sign-in → linked on that first sign-in.
 *   - Person provisioned AFTER the user already exists → linked on the next
 *     sign-in (the earlier sign-ins were a harmless no-op).
 *   - Already-linked People are NEVER touched: the `user_id IS NULL` guard both
 *     makes repeated sign-ins a no-op and prevents reassigning a Person that
 *     belongs to another account (`user.email` is unique, so a different user
 *     can never match the same email anyway).
 *
 * Because a `Person` is one row per human across all clubs, a single link grants
 * all of that person's memberships at once (intended). A no-match is a no-op —
 * the user still lands, just with no clubs (auto-creating a Person is #182, out
 * of scope here).
 *
 * @returns the ids of the People newly linked to this user (empty on a no-op).
 */
export async function linkPersonToUser(
	userId: string,
): Promise<{ linkedPersonIds: string[] }> {
	// Resolve the signed-in user's email (the match key). The session hook only
	// hands us the user id, so read the authoritative address off the user row.
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!account?.email) return { linkedPersonIds: [] };

	const linked = await db
		.update(people)
		.set({ userId })
		.where(
			and(
				isNull(people.userId),
				sql`lower(${people.email}) = lower(${account.email})`,
			),
		)
		.returning({ id: people.id });

	return { linkedPersonIds: linked.map((row) => row.id) };
}
