// Account-linking DB logic (#188, re-keyed by #756 and again by #907), split out from the
// Better-Auth config in `src/lib/auth.ts` so it is directly integration-testable.
// Kept in a `*-logic.ts` module (never client-imported) so its `#/db` → `pg`
// import stays server-side; see `members-logic.ts` for the pattern and the
// `server-modules.guard.test.ts` rationale.
//
// This module owns the whole identity-binding rule: the bind
// (`bindVerifiedPerson`, which carries the rule in its own WHERE), the read that
// EXPLAINS a refusal to a human (`rosterConflictFor`, which is that rule's exact
// complement), and the predicate every club-side writer of `people.email` must
// carry (`soleHoldingClub`, ADR-0029). Every other module imports these rather than
// restating them — the enumeration, not the predicate, is the thing that kept
// being wrong when four writers each carried their own copy of a guard (#755).
import {
	and,
	countDistinct,
	eq,
	exists,
	isNotNull,
	isNull,
	ne,
	notExists,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
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

/** A second, aliased handle on `people`, for the "any OTHER Person" arm. */
const otherPeople = alias(people, "other_people");
/** Aliased `members` for the correlated subqueries below. An alias always
 *  renders qualified; a bare table inside a hand-written `sql` subquery can
 *  lose its qualifier and compare a column to itself (#802). */
const holding = alias(members, "holding_member");
const vouching = alias(members, "vouching_member");
const otherHolding = alias(members, "other_holding_member");
/** The binding account, re-read INSIDE the bind's own statement (#1091
 *  review). Aliased so it always renders qualified (#802). */
const bindingAccount = alias(user, "binding_account");

/**
 * Does this Person COUNT as a holder of an address, for ambiguity? Only when it
 * is somebody: bound to an account, or on at least one roster (#907 review).
 * A leftover `applyMemberRemove` stripped of every membership is on no roster
 * and nobody's account; it vouches for nothing, and counting it locked a
 * removed-then-re-added member out of their own sign-in.
 *
 * `table` is `people` or an alias of it; the membership subquery is over its
 * own alias, so it always renders qualified.
 */
function countsAsHolder(table: { id: AnyPgColumn; userId: AnyPgColumn }): SQL {
	return or(
		isNotNull(table.userId),
		exists(
			db
				.select({ one: sql`1` })
				.from(otherHolding)
				.where(eq(otherHolding.personId, table.id)),
		),
	) as SQL;
}

/**
 * **The identity rule, as one SQL predicate** (#907, replacing #756's roster
 * vouch). Each arm correlated on `people.id` rather than a JS literal so
 * Postgres evaluates them against the row being updated.
 *
 *  1. **It is their address** — `people.email` normalises to `address`.
 *  2. **A club vouches** — the Person holds at least one membership.
 *  3. **The address is theirs alone** — no OTHER Person carries it who is
 *     somebody: bound to an account, or on at least one roster. A leftover with
 *     neither (`applyMemberRemove` strips the roster row and keeps the Person)
 *     vouches for nothing and must not lock the real member out.
 *
 * (`user_id IS NULL` is the fourth arm; it lives beside this in the bind's own
 * WHERE, because the explainer below answers a different question for a Person
 * that is already linked.)
 *
 * **Why the old "exactly one club holds them" arm is gone.** It existed because
 * the vouch was a per-club `members.email` that any club holding the Person
 * could type, so two clubs could disagree. The address is now ONE column on the
 * Person, and a club-side writer may set it only while it is that Person's SOLE
 * holder and nobody has bound it (`soleHoldingClub` + `isNull(people.userId)`,
 * in every such write's own WHERE). A second club therefore cannot re-key a
 * Person it shares, so a multi-club member can sign in by email again. The
 * exceptions are the bind itself and the superadmin repairs.
 *
 * **Every membership counts for arm 2: no status filter, no archived filter.**
 * A lapsed member is still somebody a club vouched for.
 *
 * Arm 2 is load-bearing on its own: `applyMemberRemove` and undoing a guest
 * conversion both leave Persons with no membership behind, and an address on
 * such a row is nobody's vouch.
 *
 * Arm 3 is the household case. One address on two Persons is an ambiguity the
 * app cannot resolve — picking a name is a claim, not proof, and both spouses
 * read the same inbox (ADR-0008: never auto-merge on a shared email). It counts
 * an already-LINKED other Person too: a typed copy of somebody's sign-in address
 * must not bind a second Person to the same inbox.
 */
function rosterPermitsBind(address: string): SQL {
	return and(
		// 1. It is their address.
		sql`${normalizedEmail(people.email)} = ${address}`,
		// 2. A club vouches.
		exists(
			db
				.select({ one: sql`1` })
				.from(vouching)
				.where(eq(vouching.personId, people.id)),
		),
		// 3. Nobody else who counts carries the address.
		notExists(
			db
				.select({ one: sql`1` })
				.from(otherPeople)
				.where(
					and(
						ne(otherPeople.id, people.id),
						sql`${normalizedEmail(otherPeople.email)} = ${address}`,
						countsAsHolder(otherPeople),
					),
				),
		),
	) as SQL;
}

/**
 * **Who on a club's side may write an existing Person's `people.email`** (#907):
 * the club is the Person's SOLE holder. Two arms, both correlated on
 * `people.id`, for use INSIDE an `update(people)`'s WHERE:
 *
 *  - exactly one distinct club holds a membership of this Person, and
 *  - that club is `clubId`.
 *
 * It is deliberately NOT the whole rule. Every club-side write site must also
 * carry `isNull(people.userId)` in the same statement — once somebody has signed
 * in, the address is theirs — and `person-email-writers.guard.test.ts` holds
 * each waived writer to BOTH tokens, separately, so neither can be dropped
 * without a red test. Being in the statement is what makes a bind that lands
 * between a form's load and its save a no-op rather than an overwrite.
 *
 * Accepted residual (ADR-0029): a second club attaching a membership in the same
 * instant is not serialised against the writer's Person lock. That attach can
 * only have matched the Person by its current address or Customer ID.
 */
export function soleHoldingClub(clubId: string): SQL {
	return and(
		sql`(${db
			.select({ n: countDistinct(holding.clubId) })
			.from(holding)
			.where(eq(holding.personId, people.id))}) = 1`,
		exists(
			db
				.select({ one: sql`1` })
				.from(vouching)
				.where(
					and(eq(vouching.personId, people.id), eq(vouching.clubId, clubId)),
				),
		),
	) as SQL;
}

/** Why a club-side writer may not change a Person's address. */
export type EmailWriteRefusal =
	/** Somebody has signed in as this Person; the address is theirs. */
	| "bound"
	/** Another club holds this Person too (or this club does not hold them). */
	| "multi_club";

/**
 * The READ form of `isNull(people.userId) AND soleHoldingClub(clubId)`, for
 * explaining a refusal and for rendering the field read-only. Never the gate:
 * that lives in each writer's own WHERE.
 *
 * @returns null when `clubId` may write the address, else why not.
 */
export async function emailWriteRefusalFor(
	personId: string,
	clubId: string,
	executor: Pick<typeof db, "select" | "selectDistinct"> = db,
): Promise<EmailWriteRefusal | null> {
	const [row] = await executor
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	if (!row) return "multi_club";
	if (row.userId) return "bound";
	const clubs = await executor
		.selectDistinct({ clubId: members.clubId })
		.from(members)
		.where(eq(members.personId, personId));
	return clubs.length === 1 && clubs[0]?.clubId === clubId
		? null
		: "multi_club";
}

/**
 * Bind a Person to a signed-in account and stamp the VERIFIED address onto it.
 * The one writer of `people.email` that writes a VERIFIED address; every other
 * writer is a named waiver in `person-email-writers.guard.test.ts` (the club-side
 * ones held to `isNull(people.userId)` AND `soleHoldingClub`, ADR-0029).
 *
 * Two properties make the name honest rather than aspirational, and both were
 * review findings against earlier cuts:
 *   - **It reads the address itself** from the `user` row rather than taking it
 *     from the caller, so no call site can label a typed string "verified".
 *   - **It carries the whole rule in its own WHERE** — `user_id IS NULL` plus
 *     `rosterPermitsBind` — rather than trusting a SELECT the caller ran first.
 *     What remains is the READ COMMITTED phantom: a row committed after this
 *     statement's snapshot is invisible to it.
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
	// The STORED address, unnormalised, for the in-statement check below that
	// the account's address is unchanged since it was read (#1091 review). It
	// is compared raw to raw: comparing `verified` (JS `.trim()`) with SQL's
	// `normalizedEmail` would refuse an address stored with a leading BOM or
	// NBSP, which the two trims treat differently, and that bind succeeded
	// before. Read second, so it must agree with `verified`; if a change landed
	// between the two reads they disagree and the bind refuses (fails closed).
	const stored = await storedEmailFor(input.userId);
	if (stored === null || normalizeEmail(stored) !== verified) return false;

	const bound = await db
		.update(people)
		.set({ userId: input.userId, email: verified })
		.where(
			and(
				eq(people.id, input.personId),
				isNull(people.userId),
				rosterPermitsBind(verified),
				// The account's stored address is UNCHANGED since it was read
				// (#1091 review). It was read above, outside this statement; a
				// change of sign-in address confirmed in between would otherwise
				// let the bind stamp the OLD address — one the account no longer
				// holds — onto this Person and bind it, past the household arm the
				// change itself moved. Not a new rule: atomicity only.
				//
				// Known limit (READ COMMITTED): this closes the window before the
				// statement starts. If the UPDATE is already waiting on this
				// Person's row lock when the change commits, Postgres re-checks only
				// the locked row (EvalPlanQual) and this subquery keeps reading the
				// statement's original snapshot.
				exists(
					db
						.select({ one: sql`1` })
						.from(bindingAccount)
						.where(
							and(
								eq(bindingAccount.id, input.userId),
								eq(bindingAccount.email, stored),
							),
						),
				),
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

/** The account's address exactly as stored, unnormalised, or null. */
async function storedEmailFor(userId: string): Promise<string | null> {
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return account?.email ?? null;
}

/** Why a bind for an address would be refused by the ROSTER. */
export type RosterObstacle =
	/** The Person's own address is not this one, or no club holds them. */
	| "no_vouching_row"
	/** Another Person carries the same address. */
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
 * Like the predicate, it says nothing about `user_id`: a caller that needs to
 * know whether the Person is already linked reads that itself.
 *
 * @returns the first obstacle found, or null when the bind would be permitted.
 */
export async function rosterConflictFor(
	personId: string,
	address: string,
): Promise<RosterObstacle | null> {
	const norm = normalizeEmail(address);
	if (!norm) return "no_vouching_row";

	const [person] = await db
		.select({ email: people.email })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	// `normalizeEmail` is the JS spelling of `normalizedEmail`; the residual
	// between them (NBSP, U+FEFF) fails closed here as it does in the bind.
	if (normalizeEmail(person?.email) !== norm) return "no_vouching_row";
	const [membership] = await db
		.select({ id: members.id })
		.from(members)
		.where(eq(members.personId, personId))
		.limit(1);
	if (!membership) return "no_vouching_row";

	const others = await db
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				ne(people.id, personId),
				sql`${normalizedEmail(people.email)} = ${norm}`,
				countsAsHolder(people),
			),
		)
		.limit(1);
	return others.length > 0 ? "shared_address" : null;
}

/**
 * Every space a stored address may carry at either end, for the COLLISION
 * question only (#1091 review): the POSIX class `normalizedEmail` trims, plus
 * the Unicode spaces JS `.trim()` also strips (NBSP, U+1680, U+2000–U+200A,
 * U+2028/9, U+202F, U+205F, U+3000, U+FEFF) and the zero-width space U+200B.
 *
 * `normalizedEmail` leaves those, which fails CLOSED for the bind (it is
 * documented there) but OPEN here: a holder stored as `victim@x.com` plus a
 * NBSP would not block a change TO `victim@x.com`. The bind rule is untouched;
 * only "is this address somebody else's" reads through this.
 */
const HELD_ADDRESS_EDGE_SPACE =
	"^[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+|[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+$";

/** A stored address, normalised for the collision question. */
function heldAddress(column: AnyPgColumn): SQL {
	return sql`lower(regexp_replace(${column}, ${HELD_ADDRESS_EDGE_SPACE}, '', 'g'))`;
}

/**
 * **Is this address already somebody else's?** (#1091, ADR-0030) The question a
 * member changing their own sign-in address must get "no" to, asked at request
 * time and again inside the confirm transaction.
 *
 * Two arms, either one refuses:
 *  - another `user` row carries it (a second account already signs in with it);
 *  - another Person carries it who COUNTS AS A HOLDER (`countsAsHolder`, the
 *    bind's own rule): bound to an account, or on at least one roster. That is
 *    ADR-0008's household case — moving an address onto this Person would make
 *    it ambiguous, and the bind refuses an ambiguous address for BOTH Persons.
 *
 * "Another" means not `userId`'s own account and not a Person bound to it. It
 * is the same predicate the bind uses, not a restatement, so a change can
 * never create an ambiguity the bind would then refuse.
 *
 * `address` must already be normalised (`normalizeEmail`). `executor` is a
 * transaction handle at confirm time, so the read sees that transaction.
 */
export async function addressHeldByAnother(
	address: string,
	userId: string,
	executor: Pick<typeof db, "select"> = db,
): Promise<boolean> {
	// BOTH arms run every time (#1091 review): the request path answers the
	// same whichever arm hits, so it must also take the same time.
	const [otherUser, otherPerson] = await Promise.all([
		executor
			.select({ id: user.id })
			.from(user)
			.where(
				and(ne(user.id, userId), sql`${heldAddress(user.email)} = ${address}`),
			)
			.limit(1),
		executor
			.select({ id: people.id })
			.from(people)
			.where(
				and(
					or(isNull(people.userId), ne(people.userId, userId)),
					sql`${heldAddress(people.email)} = ${address}`,
					countsAsHolder(people),
				),
			)
			.limit(1),
	]);
	return otherUser.length > 0 || otherPerson.length > 0;
}

/** The DISTINCT Persons whose own address is this one and who count as a
 *  holder (`countsAsHolder`), linked or not. */
async function peopleMatching(address: string): Promise<string[]> {
	const rows = await db
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				sql`${normalizedEmail(people.email)} = ${address}`,
				countsAsHolder(people),
			),
		);
	return rows.map((r) => r.id);
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
 * **The match key is `people.email`, the Person's one address (#907).** Before
 * a bind it was typed by a club, but only by a club that was the Person's sole
 * holder at the time (`soleHoldingClub`), so a club that shares a Person can
 * never re-key them. A typo is repairable from the roster edit form until the
 * member signs in — which is what used to lock members out with no UI able to
 * help (THR Speaking Club, 2026-09-12).
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
