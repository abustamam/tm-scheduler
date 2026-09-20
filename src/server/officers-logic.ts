import { and, eq, isNull } from "drizzle-orm";
import type { db } from "#/db";
import { officerTerms } from "#/db/schema";
import type { OfficerPosition } from "#/lib/officers";

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
