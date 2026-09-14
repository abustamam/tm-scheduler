// Account-linking DB logic (#188, re-keyed by #756), split out from the
// Better-Auth config in `src/lib/auth.ts` so it is directly integration-testable.
// Kept in a `*-logic.ts` module (never client-imported) so its `#/db` → `pg`
// import stays server-side; see `members-logic.ts` for the pattern and the
// `server-modules.guard.test.ts` rationale.
//
// This module owns the whole identity-binding rule: the one WRITER of
// `people.email` (`bindVerifiedPerson`) and the one READ site of the
// blast-radius rule (`personHeldBySingleClub`). `account-invite-logic.ts`
// imports both rather than restating them — the enumeration, not the predicate,
// is the thing that kept being wrong when four writers each carried their own
// copy of a guard (#755).
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people, user } from "#/db/schema";

/** Anything that can run a select — the `db` client or a transaction. */
export type QueryHandle = Pick<typeof db, "select">;

/**
 * Is `personId` held by exactly one club? **The blast-radius rule, and its only
 * definition.**
 *
 * A Person is one row per human across every club (ADR-0008), and
 * `members.email` is a column any officer of any of that Person's clubs
 * controls. So a membership address may decide who a Person becomes only when
 * the club that typed it is the Person's sole stakeholder. With a second club on
 * the row, club A's officer could type their own address onto their membership
 * row and inherit club B's membership at whatever role the victim held —
 * reproduced end to end four times over on #755, once per writer that was
 * missed.
 *
 * Both identity readers ask this one question: `linkPersonToUser` below, and
 * `claimPersonForUser` in `account-invite-logic.ts`. It replaced a predicate
 * that had to be repeated at every WRITER of `people.email`; there is nothing to
 * enumerate now, because a club-scoped actor no longer writes the column at all.
 *
 * Counts DISTINCT clubs, not membership rows — `members_club_person_unique`
 * makes those the same today, and counting clubs is what the rule actually
 * means.
 */
export async function personHeldBySingleClub(
	handle: QueryHandle,
	personId: string,
): Promise<boolean> {
	const [row] = await handle
		.select({ clubs: sql<number>`count(distinct ${members.clubId})::int` })
		.from(members)
		.where(eq(members.personId, personId));
	return (row?.clubs ?? 0) === 1;
}

/**
 * Bind a Person to a signed-in account and stamp the VERIFIED address onto it.
 * **The only writer of `people.email` reachable by anyone but a superadmin**
 * (`person-email-writers.guard.test.ts` is the enumeration), and it writes only
 * an address a magic link just proved this account owns.
 *
 * That is the whole of #756: the column means "an address this human proved they
 * own", never "whatever an officer last typed". Callers are responsible for
 * deciding that this account MAY have this Person — see `linkPersonToUser` below
 * and `claimPersonForUser` — this function only makes the write atomic.
 *
 * Guarded on `user_id IS NULL`, so a Person that already holds an account is
 * never reassigned and a concurrent bind resolves deterministically (the loser
 * gets `false` and re-reads).
 */
export async function bindVerifiedPerson(input: {
	personId: string;
	userId: string;
	verifiedEmail: string;
}): Promise<boolean> {
	const bound = await db
		.update(people)
		.set({ userId: input.userId, email: input.verifiedEmail })
		.where(and(eq(people.id, input.personId), isNull(people.userId)))
		.returning({ id: people.id });
	return bound.length > 0;
}

/**
 * Auto-link on sign-in: bind the roster `Person` this verified address belongs
 * to (ADR-0008 Phase B — the auth link lives on `people.user_id`).
 *
 * Called from the Better-Auth `session.create.after` hook, so it fires on EVERY
 * successful sign-in (magic-link is the only method), IDEMPOTENTLY:
 *   - Person provisioned BEFORE first sign-in → linked on that first sign-in.
 *   - Person provisioned AFTER the user already exists → linked on the next
 *     sign-in (the earlier sign-ins were a harmless no-op).
 *   - Already-linked People are NEVER touched (`bindVerifiedPerson`'s
 *     `user_id IS NULL` guard).
 *
 * **The match key is `members.email`, the club's own contact record — NOT
 * `people.email` (#756).** `people.email` is written at Person CREATION by the
 * CSV importer, the guest-book conversion and the create-club form, always from
 * a value a club-scoped actor typed, so it is a dedupe hint and never a
 * credential. Matching on it is what let a mistyped address lock a member out
 * with no UI able to repair it (THR Speaking Club, 2026-09-12) and what made
 * every writer of the column a potential cross-club takeover.
 *
 * Three conditions, all necessary:
 *   - **exactly one** unlinked Person across the matching membership rows. A
 *     household address genuinely shared by two people is real
 *     (`listDuplicatePeople` exists because of it) and ADR-0008 says never to
 *     auto-merge on one; guessing hands someone their spouse's club.
 *   - that Person is held by **exactly one club** (`personHeldBySingleClub`).
 *   - that Person has **no account** (`bindVerifiedPerson`).
 *
 * A no-match is a no-op — the user still lands, just with no clubs
 * (auto-creating a Person is #182, out of scope here). Repairing a typo is now
 * the ordinary flow: correct `members.email`, re-invite, the member clicks.
 *
 * @returns the ids of the People newly linked to this user (empty on a no-op).
 * At most one, but kept an array for its callers and for the duplicate-Person
 * case discussed in `auth-context-person-logic.ts`.
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
	const verified = account?.email?.trim().toLowerCase() || null;
	if (!verified) return { linkedPersonIds: [] };

	// Candidates: the DISTINCT unlinked People whose membership contact address
	// is this one. Normalised on both sides — the CSV importer and the guest
	// pipeline write `members.email` without trimming, and a stray space must not
	// silently cost a member their sign-in.
	const candidates = await db
		.selectDistinct({ personId: members.personId })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(
			and(
				isNull(people.userId),
				sql`lower(trim(${members.email})) = ${verified}`,
			),
		);
	// Zero is the ordinary no-match; two or more is an ambiguity we refuse to
	// resolve rather than guess at.
	if (candidates.length !== 1) return { linkedPersonIds: [] };
	const personId = candidates[0]?.personId;
	if (!personId) return { linkedPersonIds: [] };

	if (!(await personHeldBySingleClub(db, personId))) {
		return { linkedPersonIds: [] };
	}

	const bound = await bindVerifiedPerson({
		personId,
		userId,
		verifiedEmail: verified,
	});
	return { linkedPersonIds: bound ? [personId] : [] };
}
