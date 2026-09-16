// Account-linking DB logic (#188, re-keyed by #756), split out from the
// Better-Auth config in `src/lib/auth.ts` so it is directly integration-testable.
// Kept in a `*-logic.ts` module (never client-imported) so its `#/db` → `pg`
// import stays server-side; see `members-logic.ts` for the pattern and the
// `server-modules.guard.test.ts` rationale.
//
// This module owns the whole identity-binding rule: the one WRITER of
// `people.email` (`bindVerifiedPerson`, which carries the rule in its own WHERE)
// and the read that EXPLAINS a refusal to a human (`rosterConflictFor`, which is
// that rule's exact complement). Every other module imports these rather than
// restating them — the enumeration, not the predicate, is the thing that kept
// being wrong when four writers each carried their own copy of a guard (#755).
import {
	and,
	eq,
	exists,
	isNull,
	ne,
	notExists,
	type SQL,
	sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "#/db";
import { members, people, user } from "#/db/schema";

/**
 * One spelling of "normalise an address", for the SQL side. **Exported: use it
 * at every reader.** Four copies of this expression drifted apart inside a
 * single change — one of them the `lower(trim(...))` form documented below as a
 * bug — and one index can never serve two spellings.
 *
 * Postgres `trim()` strips SPACES only while JS `.trim()` strips every Unicode
 * space, so spelling one reader `lower(trim(...))` and the other
 * `.trim().toLowerCase()` made a roster address with a trailing TAB match on the
 * claim path and not at sign-in.
 *
 * The POSIX class is still NOT identical to JS: `[[:space:]]` leaves U+00A0
 * (NBSP) and U+FEFF, which `.trim()` removes. Both are reachable by pasting from
 * Word or Outlook. That residual is recorded rather than claimed away — it fails
 * CLOSED on the binding path (the address is harder to vouch for, easier to be
 * dissented from), so it costs a refusal and never a bind.
 */
export function normalizedEmail(column: AnyPgColumn): SQL {
	return sql`lower(regexp_replace(${column}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))`;
}

/** The JS side of the same operation. Keep the two in step. */
export function normalizeEmail(
	value: string | null | undefined,
): string | null {
	return value?.trim().toLowerCase() || null;
}

/**
 * **The identity rule, as one SQL predicate.** Three arms, each correlated on
 * `people.id` rather than a JS literal so Postgres evaluates them as SubPlans
 * against the row being updated instead of hoisting them into InitPlans that run
 * on every sign-in (measured: 18.9ms → 0.7ms for an already-linked user, who
 * otherwise pays the whole cost for an UPDATE matching 0 rows).
 *
 *  1. **Somebody vouches** — a membership of this Person carries `address`.
 *  2. **Exactly one club holds them** — `count(distinct club_id) = 1`.
 *  3. **The address is theirs alone** — no OTHER Person's membership carries it.
 *
 * **Every membership counts: no status filter, no archived filter.** That is the
 * scar from the cut this replaces. A "unanimity among the clubs that hold them"
 * rule scoped the dissenting set to ACTIVE rows in unarchived clubs, which left
 * a Person whose memberships had all lapsed with NO dissenters — so a club admin
 * who attached them (the CSV importer matches Customer ID globally, with no club
 * scope) supplied the only vouching row themselves and took the Person, along
 * with their speeches, Pathways progress, and any membership that later
 * reactivated. Narrowing the set was the whole of that bug.
 *
 * Arm 1 is load-bearing on its own: without it the two NOT EXISTS arms are
 * vacuously true for a Person with no memberships, so any address at all would
 * bind them. `applyMemberRemove` and undoing a guest conversion both leave such
 * rows behind.
 *
 * Arm 3 is the household case. One address on two roster rows is an ambiguity
 * the app cannot resolve — picking a name is a claim, not proof, and both
 * spouses read the same inbox. It lives in the WRITE rather than only in the
 * sign-in resolver, because the explicit claim reaches the same bind by a
 * different route.
 *
 * **What this rule costs, stated rather than hidden:** a member two clubs
 * genuinely hold cannot bind by any route until one membership is removed, and a
 * club admin who attaches an arbitrary Person to their own club can put them in
 * that state. Both are recorded in CODING_STANDARDS under "Still open"; the fix
 * for the second is to gate the attach, which is its own change.
 */
function rosterPermitsBind(address: string): SQL {
	return and(
		// 1. Somebody vouches.
		exists(
			db
				.select({ one: sql`1` })
				.from(members)
				.where(
					and(
						eq(members.personId, people.id),
						sql`${normalizedEmail(members.email)} = ${address}`,
					),
				),
		),
		// 2. Exactly one club holds them.
		sql`(select count(distinct ${members.clubId}) from ${members} where ${members.personId} = ${people.id}) = 1`,
		// 3. Nobody else carries the address.
		notExists(
			db
				.select({ one: sql`1` })
				.from(members)
				.where(
					and(
						ne(members.personId, people.id),
						sql`${normalizedEmail(members.email)} = ${address}`,
					),
				),
		),
	) as SQL;
}

/**
 * Bind a Person to a signed-in account and stamp the VERIFIED address onto it.
 * **The only writer of `people.email` outside the superadmin/operator waivers**
 * (`person-email-writers.guard.test.ts` is the enumeration).
 *
 * Two properties make the name honest rather than aspirational, and both were
 * review findings against earlier cuts:
 *   - **It reads the address itself** from the `user` row rather than taking it
 *     from the caller, so no call site can label a typed string "verified".
 *   - **It carries the whole rule in its own WHERE** — `user_id IS NULL` plus
 *     `rosterPermitsBind` — rather than trusting a SELECT the caller ran first.
 *     What remains is the READ COMMITTED phantom: a membership committed after
 *     this statement's snapshot is invisible to it.
 *
 * @returns whether the bind landed. `false` covers every refusal, so a caller
 * that needs to tell a human WHY asks `rosterConflictFor` — this predicate's
 * exact complement, which must stay that way.
 */
export async function bindVerifiedPerson(input: {
	personId: string;
	userId: string;
}): Promise<boolean> {
	const verified = await verifiedEmailFor(input.userId);
	if (!verified) return false;

	const bound = await db
		.update(people)
		.set({ userId: input.userId, email: verified })
		.where(
			and(
				eq(people.id, input.personId),
				isNull(people.userId),
				rosterPermitsBind(verified),
			),
		)
		.returning({ id: people.id });
	return bound.length > 0;
}

/** The address a magic link proved this account owns, normalised. */
export async function verifiedEmailFor(userId: string): Promise<string | null> {
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return normalizeEmail(account?.email);
}

/** Why a bind for an address would be refused by the ROSTER. */
export type RosterObstacle =
	/** No membership of this Person carries the address. */
	| "no_vouching_row"
	/** More than one club holds this Person. */
	| "multiple_clubs"
	/** Another Person's roster row carries the same address. */
	| "shared_address";

/**
 * **The exact complement of `rosterPermitsBind`**, as a read, for messaging.
 * Never for authorization — that lives in the UPDATE's own WHERE.
 *
 * "Exact complement" is the contract, and it has teeth. An earlier cut checked
 * only two of the three arms, and every surface using it as a pre-flight was
 * then blind to the third: the invite reported `ready` for a member no row
 * vouched for, minted a real account through Better-Auth, and the claim then
 * refused — the silent half-failure this release exists to delete, reappearing
 * inside the code written to delete it. `roster-obstacle.guard.test.ts` pins the
 * two against each other.
 *
 * @returns the first obstacle found, or null when the bind would be permitted.
 */
export async function rosterConflictFor(
	personId: string,
	address: string,
): Promise<RosterObstacle | null> {
	const norm = normalizeEmail(address);
	if (!norm) return "no_vouching_row";

	const [counts] = await db
		.select({
			vouching: sql<number>`count(*) filter (where ${normalizedEmail(members.email)} = ${norm})::int`,
			clubs: sql<number>`count(distinct ${members.clubId})::int`,
		})
		.from(members)
		.where(eq(members.personId, personId));

	if ((counts?.vouching ?? 0) === 0) return "no_vouching_row";
	if ((counts?.clubs ?? 0) !== 1) return "multiple_clubs";

	const others = await db
		.select({ personId: members.personId })
		.from(members)
		.where(
			and(
				ne(members.personId, personId),
				sql`${normalizedEmail(members.email)} = ${norm}`,
			),
		)
		.limit(1);
	return others.length > 0 ? "shared_address" : null;
}

/** The DISTINCT Persons any roster row carries this address for. */
async function peopleMatching(address: string): Promise<string[]> {
	const rows = await db
		.selectDistinct({ personId: members.personId })
		.from(members)
		.where(sql`${normalizedEmail(members.email)} = ${address}`);
	return rows.map((r) => r.personId);
}

/**
 * Auto-link on sign-in: bind the roster `Person` this verified address belongs
 * to (ADR-0008 Phase B — the auth link lives on `people.user_id`).
 *
 * Called from the Better-Auth `session.create.after` hook, so it fires on EVERY
 * successful sign-in (magic-link is the only method), IDEMPOTENTLY: a Person
 * provisioned before or after the account links on the next sign-in either way,
 * and an already-linked Person is never touched.
 *
 * **The match key is `members.email`, the club's own contact record — NOT
 * `people.email` (#756).** `people.email` is written at Person CREATION by the
 * CSV importer, the guest-book conversion, the bulk paste and the create-club
 * form, always from a value a club-scoped actor typed, so it is a dedupe hint
 * and never a credential. Matching on it is what let a mistyped address lock a
 * member out with no UI able to repair it (THR Speaking Club, 2026-09-12).
 *
 * The candidate count requires **exactly one Person**, counting already-LINKED
 * ones. That is not an oversight: filtering them out let the second spouse
 * become the sole candidate once the first had claimed their own row, binding
 * his membership and his roles to her account on her next sign-in. Two rows
 * carrying one address is an ambiguity whoever holds them; `mergePeople` is the
 * repair when they are genuinely one human, at the cost of the duplicate-Person
 * case no longer self-healing on sign-in.
 *
 * @returns the ids of the People newly linked to this user (empty on a no-op).
 * At most one; kept an array for its callers.
 */
export async function linkPersonToUser(
	userId: string,
): Promise<{ linkedPersonIds: string[] }> {
	const verified = await verifiedEmailFor(userId);
	if (!verified) return { linkedPersonIds: [] };

	// Zero is the ordinary no-match; two or more is an ambiguity we refuse to
	// resolve rather than guess at. The bind re-checks this arm itself, so this
	// is candidate SELECTION, not the guard.
	const candidates = await peopleMatching(verified);
	if (candidates.length !== 1) return { linkedPersonIds: [] };
	const personId = candidates[0];
	if (!personId) return { linkedPersonIds: [] };

	const bound = await bindVerifiedPerson({ personId, userId });
	return { linkedPersonIds: bound ? [personId] : [] };
}
