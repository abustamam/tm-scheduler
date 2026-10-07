// The ONE answer to "is this area current" and "who is this area's current
// director" (#1116, part of #1115). The Area Director's notice (#1118), the
// guard and auth context (#1119) and the visits (#1120) all ask it, and they
// must ask it this way, or the notice and the access can disagree about the
// same person on the same day. Nothing else restates the rule; import it.
//
// OPEN is not CURRENT. `area_directors.ended_at IS NULL` means the term is
// open. A term is current only while it is open AND its area's division is in
// the current program year. A past year's open term is never ended and needs no
// ending: this year check retires it on July 1, and a division created for the
// NEXT year, with its areas staffed in June, does not take effect until then.
//
// Plain logic module: no `createServerFn`, and never imported by client code
// (it reaches `#/db`).
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "#/db";
import { areaDirectors, areas, divisions } from "#/db/schema";
import { areaLabel } from "#/lib/area-health-fields";
import { currentProgramYear } from "#/lib/dcp";

/** The condition "this division is in the current program year". */
export function isCurrentDivision(now: Date = new Date()): SQL {
	return eq(divisions.programYear, currentProgramYear(now));
}

/**
 * The condition "this term is current": open, and in a current division. The
 * caller joins `area_directors` → `areas` → `divisions`.
 */
export function isCurrentTerm(now: Date = new Date()): SQL {
	return and(isNull(areaDirectors.endedAt), isCurrentDivision(now)) as SQL;
}

/** An area's current director, or null when it has none. */
export async function loadCurrentDirector(
	areaId: string,
	now: Date = new Date(),
): Promise<{ userId: string; displayName: string } | null> {
	const [row] = await db
		.select({
			userId: areaDirectors.userId,
			displayName: areaDirectors.displayName,
		})
		.from(areaDirectors)
		.innerJoin(areas, eq(areas.id, areaDirectors.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.where(and(eq(areaDirectors.areaId, areaId), isCurrentTerm(now)));
	return row ?? null;
}

/** The areas a user is the current director of, sorted by label ("B2", "C3"). */
export async function loadCurrentAreasForUser(
	userId: string,
	now: Date = new Date(),
): Promise<{ id: string; label: string }[]> {
	const rows = await db
		.select({
			id: areas.id,
			number: areas.number,
			letter: divisions.letter,
		})
		.from(areaDirectors)
		.innerJoin(areas, eq(areas.id, areaDirectors.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.where(and(eq(areaDirectors.userId, userId), isCurrentTerm(now)))
		.orderBy(asc(divisions.letter), asc(areas.number));
	return rows
		.map((r) => ({ id: r.id, label: areaLabel(r.letter, r.number) }))
		.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
}
