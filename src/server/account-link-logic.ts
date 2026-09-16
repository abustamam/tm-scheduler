// Account-linking DB logic (#188, re-keyed by #756), split out from the
// Better-Auth config in `src/lib/auth.ts` so it is directly integration-testable.
// Kept in a `*-logic.ts` module (never client-imported) so its `#/db` → `pg`
// import stays server-side; see `members-logic.ts` for the pattern and the
// `server-modules.guard.test.ts` rationale.
//
// This module owns the whole identity-binding rule: the one WRITER of
// `people.email` (`bindVerifiedPerson`, which carries the rule in its own WHERE)
// and the read that EXPLAINS a refusal to a human (`rosterConflictFor`).
// `account-invite-logic.ts` imports both rather than restating them — the
// enumeration, not the predicate, is the thing that kept being wrong when four
// writers each carried their own copy of a guard (#755).
import {
	and,
	eq,
	exists,
	isNull,
	ne,
	notExists,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people, user } from "#/db/schema";

/**
 * One spelling of "normalise an address", for the SQL side.
 *
 * Postgres `trim()` strips SPACES only while JS `.trim()` strips every Unicode
 * space, so spelling one reader `lower(trim(...))` and the other
 * `.trim().toLowerCase()` made a roster address with a trailing TAB match on the
 * claim path and not at sign-in — the muted version of the "corrected on the
 * roster, still locked out" asymmetry this whole change exists to remove. The
 * POSIX class matches what JS does closely enough that no realistic address can
 * tell them apart.
 */
function normalized(column: typeof members.email): SQL {
	return sql`lower(regexp_replace(${column}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))`;
}

/** The JS side of the same operation. Keep the two in step. */
export function normalizeEmail(
	value: string | null | undefined,
): string | null {
	return value?.trim().toLowerCase() || null;
}

/**
 * The roster rows that get a say in who a Person is: an ACTIVE membership in a
 * club that has not been archived.
 *
 * Both exclusions are deliberate and neither weakens the rule below.
 *   - **Inactive**: someone who left a club years ago must not have their
 *     identity held hostage by that club's stale row. An officer marking their
 *     own row inactive only withdraws their own objection; it can never
 *     manufacture agreement.
 *   - **Archived**: archiving is the takedown lever (ADR-0016) and is
 *     superadmin-only. An archived club is inaccessible everywhere else in the
 *     app; it does not keep a vote on who its former members are.
 */
function liveMembership(personId: string, extra: SQL) {
	return db
		.select({ one: sql`1` })
		.from(members)
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.where(
			and(
				eq(members.personId, personId),
				eq(members.status, "active"),
				isNull(clubs.archivedAt),
				extra,
			),
		);
}

/**
 * **The identity rule, as one SQL predicate: unanimity among the clubs that hold
 * this Person.** At least one live roster row carries `address`, and none
 * carries anything else.
 *
 * Why unanimity rather than "only one club may hold them", which is what the
 * first cut of #756 used and what review killed. That rule was wrong in two
 * directions at once:
 *   - it denied an account to every dual-club member — routine in Toastmasters —
 *     by every route at once, with no repair a club could perform; and
 *   - its only input was `members`, a table the actor it constrains can write.
 *     Any club admin could push an arbitrary Person into the refused state
 *     through the CSV importer's GLOBAL Customer-ID match, turning a takeover
 *     guard into a denial-of-account weapon aimed at another club's member.
 *
 * Unanimity is monotone in the attacker's direction: a club joining the Person
 * can only ADD a row that must also agree, never satisfy one. Club A's officer
 * typing their own address on club A's row makes club B's row disagree, so the
 * bind refuses — and the repair is the ordinary one, put the member's real
 * address on the roster in every club that holds them.
 *
 * The "at least one" arm is load-bearing on its own: unanimity over an empty set
 * is vacuously true, so without it a Person whose every membership had lapsed
 * would bind to any address at all.
 */
function rosterAgreesOn(personId: string, address: string): SQL {
	return and(
		// Somebody vouches: a live row of THIS Person carries the address.
		exists(
			liveMembership(personId, sql`${normalized(members.email)} = ${address}`),
		),
		// Nobody dissents: no live row of this Person says anything else.
		notExists(
			liveMembership(
				personId,
				or(
					isNull(members.email),
					sql`${normalized(members.email)} <> ${address}`,
				) as SQL,
			),
		),
		// And the address belongs to this Person ALONE. A household address on two
		// roster rows is an ambiguity the app cannot resolve — picking a name is a
		// claim, not proof, and both spouses can read the same inbox. This arm lives
		// in the WRITE rather than only in the sign-in resolver because the explicit
		// claim reaches the same bind by a different route: without it,
		// `claimPersonForUser` happily bound whichever row the user picked.
		notExists(
			db
				.select({ one: sql`1` })
				.from(members)
				.innerJoin(clubs, eq(clubs.id, members.clubId))
				.where(
					and(
						ne(members.personId, personId),
						eq(members.status, "active"),
						isNull(clubs.archivedAt),
						sql`${normalized(members.email)} = ${address}`,
					),
				),
		),
	) as SQL;
}

/**
 * Bind a Person to a signed-in account and stamp the VERIFIED address onto it.
 * **The only writer of `people.email` outside the two superadmin waivers**
 * (`person-email-writers.guard.test.ts` is the enumeration).
 *
 * Two properties make the name honest rather than aspirational, and both were
 * review findings against the first cut:
 *   - **It reads the address itself** from the `user` row rather than taking it
 *     from the caller, so no call site can label a typed string "verified".
 *   - **It carries the whole rule in its own WHERE** — `user_id IS NULL` plus
 *     `rosterAgreesOn` — rather than trusting a SELECT the caller ran first. The
 *     first cut did the club check as a separate round trip, which is a
 *     check-then-write with a window between them; the deleted predicate it
 *     replaced had been part of the UPDATE all along. What remains is the
 *     READ COMMITTED phantom (a membership committed after this statement's
 *     snapshot is invisible to it), recorded in CODING_STANDARDS.
 *
 * @returns whether the bind landed. `false` covers every refusal — already
 * linked, roster disagreement, no verified address — so a caller that needs to
 * tell a human WHY asks `rosterConflictFor` afterwards.
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
				rosterAgreesOn(input.personId, verified),
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

/**
 * Would a bind for `address` be refused by the ROSTER rather than by the
 * account? Read-only, and for messaging only — never for authorization, which
 * `bindVerifiedPerson`'s own WHERE does.
 *
 * True when another live roster row disagrees about this Person's address, or
 * when the address sits on more than one member's row. Both mean a human has to
 * sort the roster out, and both have the same remedy, which is why the callers
 * report them as one outcome: make sure each member's roster email is their own,
 * and that it matches in every club that holds them.
 */
export async function rosterConflictFor(
	personId: string,
	address: string,
): Promise<boolean> {
	const norm = normalizeEmail(address);
	if (!norm) return false;

	const disagreeing = await liveMembership(
		personId,
		or(
			isNull(members.email),
			sql`${normalized(members.email)} <> ${norm}`,
		) as SQL,
	).limit(1);
	if (disagreeing.length > 0) return true;

	return (await peopleMatching(norm)).length > 1;
}

/** The DISTINCT Persons a live roster row carries this address for. */
async function peopleMatching(address: string): Promise<string[]> {
	const rows = await db
		.selectDistinct({ personId: members.personId })
		.from(members)
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.where(
			and(
				eq(members.status, "active"),
				isNull(clubs.archivedAt),
				sql`${normalized(members.email)} = ${address}`,
			),
		);
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
 * Two conditions, and the second lives in the write:
 *   - **exactly one Person** carries this address on a live roster row. A
 *     household address genuinely shared by two people is real
 *     (`listDuplicatePeople` exists because of it) and ADR-0008 says never to
 *     auto-merge on one. **Already-linked Persons count here**, which is not an
 *     oversight: filtering them out let the second spouse become the sole
 *     candidate once the first had claimed their own row, binding his membership
 *     and his roles to her account on her next sign-in. Two rows carrying one
 *     address is an ambiguity whoever holds them; `mergePeople` is the repair
 *     when they are genuinely one human, at the cost of the duplicate-Person
 *     case no longer self-healing on sign-in.
 *   - the roster **agrees** (`bindVerifiedPerson`).
 *
 * A no-match is a no-op — the user still lands, just with no clubs (auto-creating
 * a Person is #182, out of scope here).
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
	// resolve rather than guess at.
	const candidates = await peopleMatching(verified);
	if (candidates.length !== 1) return { linkedPersonIds: [] };
	const personId = candidates[0];
	if (!personId) return { linkedPersonIds: [] };

	const bound = await bindVerifiedPerson({ personId, userId });
	return { linkedPersonIds: bound ? [personId] : [] };
}
