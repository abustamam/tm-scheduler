// The Area Director guard (#1119, part of #1115, ADR-0032): the first reader
// that crosses clubs, and the only door to it.
//
// WHAT IT GRANTS. A person with a CURRENT term on an area may read that area's
// health counts (`area-health-logic.ts`, #1117) and nothing else. It changes no
// club guard and no public reader: a director who is not a member of a club
// gets from that club exactly what a signed-out visitor gets.
//
// WHY IT IS NOT IN `guards.ts`. Every club guard lives there, and a guard that
// cannot be reached from a club guard cannot widen one. `requireMembership`,
// `requireClubRole`, `requireClubViewAccess`, `requireClubAdminView`,
// `club-readable-logic.ts` and `meeting-authz-logic.ts` never reference
// `area_directors`, and `area-access.guard.test.ts` fails if one does. The
// import runs one way only: this file reads the refusal message FROM
// `guards.ts`; nothing there reads from here.
//
// SUPERADMIN DOES NOT PASS IT (ADR-0016 section 4: no ambient cross-club
// bypass). A superadmin with no term is refused here, and reaches the same
// numbers through `previewConsoleArea`, which is gated on `requireSuperadmin`.
//
// "CURRENT" is #1116's predicate (`isCurrentTerm`, `area-terms-logic.ts`) and is
// never restated here: the term is open AND its area's division is in the
// current program year. A second copy could disagree with the notice and the
// nav about the same person on the same day. Asked on every call, never cached,
// so ending a term in the console removes access on the next request.
//
// Plain logic module: no `createServerFn`, never imported by client code.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { areaDirectors, areas, divisions } from "#/db/schema";
import { isCurrentTerm } from "./area-terms-logic";
import { NO_PERMISSION_MESSAGE } from "./guards";

const uuid = z.string().uuid();

/**
 * Throws `NO_PERMISSION_MESSAGE` unless `userId` holds a current Area Director
 * term on `areaId`. An area that does not exist, a term that has ended, a term
 * on a past year's area and a user with no term at all are all the same
 * refusal, so the answer does not say which areas exist. An id that is not a
 * uuid is refused before the database is asked, rather than failing in it.
 */
export async function requireAreaDirector(
	userId: string,
	areaId: string,
): Promise<void> {
	if (!uuid.safeParse(areaId).success) throw new Error(NO_PERMISSION_MESSAGE);
	const [term] = await db
		.select({ id: areaDirectors.id })
		.from(areaDirectors)
		.innerJoin(areas, eq(areas.id, areaDirectors.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.where(
			and(
				eq(areaDirectors.userId, userId),
				eq(areaDirectors.areaId, areaId),
				isCurrentTerm(),
			),
		)
		.limit(1);
	if (!term) throw new Error(NO_PERMISSION_MESSAGE);
}
