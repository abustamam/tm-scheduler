// What a club's admins are told about their Area Director (#1118, part of
// #1115). The notice names the area the club sits in THIS program year and the
// director who currently holds it, so a club learns who can see its numbers
// before #1119 lets anyone see them.
//
// "Current" is not decided here. The area is the one whose division passes
// `isCurrentDivision()` and the director is `loadCurrentDirector()`, both from
// `area-terms-logic.ts`: the same predicate #1119's guard uses, so the notice
// names exactly the director who has access, and is empty exactly when no
// director can see the club. Restating either rule here is how the notice and
// the access come to disagree about one person on one day.
//
// Plain logic module: no `createServerFn`, and never imported by client code
// as a value (it reaches `#/db`). The component takes the shape below with
// `import type`, which is erased.
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { areaClubs, areas, districts, divisions } from "#/db/schema";
import { areaLabel } from "#/lib/area-health-fields";
import { isCurrentDivision, loadCurrentDirector } from "./area-terms-logic";

export interface ClubAreaNotice {
	/** The area as members say it: division letter + area number, "C3". */
	areaLabel: string;
	divisionLetter: string;
	districtNumber: string;
	/** The current director's typed `display_name`, or null when none is
	 *  current. Never `user.name`, which is "" for a magic-link account. */
	directorName: string | null;
}

/**
 * The area this club sits in this program year, and its current director, or
 * null when the club is in no area this year (none at all, only last year's, or
 * a name-only row that was never linked to it).
 *
 * `area_clubs` carries no year of its own: the year is on the division, so the
 * join through `areas` to `divisions` is what keeps last year's placement out.
 * One area per club per program year is enforced on write (`areas-logic.ts`);
 * the ORDER BY only makes the read deterministic should that ever not hold.
 */
export async function loadClubAreaNoticeDb(
	clubId: string,
	now: Date = new Date(),
): Promise<ClubAreaNotice | null> {
	const [row] = await db
		.select({
			areaId: areas.id,
			areaNumber: areas.number,
			divisionLetter: divisions.letter,
			districtNumber: districts.number,
		})
		.from(areaClubs)
		.innerJoin(areas, eq(areas.id, areaClubs.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.innerJoin(districts, eq(districts.id, divisions.districtId))
		.where(and(eq(areaClubs.clubId, clubId), isCurrentDivision(now)))
		.orderBy(asc(areaClubs.createdAt), asc(areaClubs.id))
		.limit(1);
	if (!row) return null;
	const director = await loadCurrentDirector(row.areaId, now);
	return {
		areaLabel: areaLabel(row.divisionLetter, row.areaNumber),
		divisionLetter: row.divisionLetter,
		districtNumber: row.districtNumber,
		directorName: director?.displayName ?? null,
	};
}
