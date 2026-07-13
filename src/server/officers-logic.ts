import { and, eq, isNull } from "drizzle-orm";
import type { db } from "#/db";
import { officerTerms } from "#/db/schema";
import type { OfficerPosition } from "#/lib/officers";

type Database = typeof db;

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
