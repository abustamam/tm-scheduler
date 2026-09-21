import { and, eq, isNull } from "drizzle-orm";
import type { db } from "#/db";
import { officerTerms } from "#/db/schema";
import { type OfficerPosition, officerRank } from "#/lib/officers";

// The shared client OR a drizzle transaction handle, the same union
// `officer-terms-logic.ts` takes and for the same reason: a caller that is
// already inside a transaction (convert, #501) must read the open terms through
// THIS function rather than a second copy of the query, or the disclosure it
// drives can drift from the gate `requireClubRole` actually enforces.
type Database =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * The open officer positions a membership currently holds (#202) — offices with
 * no `term_end`. Pure db logic (type-only `db` import) so it's testable against
 * a test database; `guards.ts` and `auth-context.ts` call it with the real
 * client. Drives effective-admin (any officer is an admin) + the officer home.
 */
export async function getOpenOfficerPositions(
	database: Database,
	membershipId: string,
): Promise<OfficerPosition[]> {
	const rows = await database
		.select({ position: officerTerms.position })
		.from(officerTerms)
		.where(
			and(
				eq(officerTerms.membershipId, membershipId),
				isNull(officerTerms.termEnd),
			),
		);
	return rows.map((r) => r.position);
}

/**
 * End every OPEN officer term a membership holds, returning the positions it
 * actually closed, President first (#805).
 *
 * The exact inverse of {@link getOpenOfficerPositions}, deliberately in the
 * same module as it. That function is the seam `guards.ts` grants
 * effective-admin from — any open term makes a membership a full club admin
 * whatever `club_role` says (#202) — so the query that REVOKES that grant has
 * to match the query that confers it, predicate for predicate. Two copies of
 * "which terms are open" in two modules is how a revocation ends up closing a
 * different set from the one the gate reads.
 *
 * ONE statement, not a read followed by writes: `UPDATE … RETURNING` closes the
 * rows and reports them in the same round trip, so the positions handed back
 * are exactly the ones this call ended — never a snapshot taken before a
 * concurrent close, which is what a select-then-update would disclose. The
 * caller shows that list to a human, so over- and under-stating it are both
 * bugs.
 *
 * Rows are CLOSED, never deleted — `term_end` is set and the history stays, the
 * same way removing an office from the member edit form does (#100). That is
 * what keeps `applyUndoGuestConversion`'s refusal ("this member has an officer
 * term of their own now") covering every conversion that calls this: the row is
 * still there afterwards to be counted.
 *
 * Not `reconcileOfficerTerms(client, id, [])`, which would do the same thing
 * through the roster editor's desired-set path: that function's contract is
 * "make the open set exactly `desired`", and every other caller passes a
 * line-up a human chose. This verb is "end what is open", it needs no desired
 * set, and it is one statement rather than one per term.
 */
export async function closeOpenOfficerTerms(
	database: Database,
	membershipId: string,
	closedAt: Date = new Date(),
): Promise<OfficerPosition[]> {
	const rows = await database
		.update(officerTerms)
		.set({ termEnd: closedAt, updatedAt: closedAt })
		.where(
			and(
				eq(officerTerms.membershipId, membershipId),
				isNull(officerTerms.termEnd),
			),
		)
		.returning({ position: officerTerms.position });
	// Canonical order, because this list is read aloud in a toast. Postgres
	// returns updated rows in no defined order, so without this the same two
	// offices could be named "Treasurer and President" on one convert and
	// "President and Treasurer" on the next.
	return rows
		.map((r) => r.position)
		.sort((a, b) => officerRank(a) - officerRank(b));
}
