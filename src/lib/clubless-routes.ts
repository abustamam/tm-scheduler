/**
 * Which pages a person with NO club may still open (#1119), decided in one
 * place so `_authed.tsx` and its tests agree.
 *
 * `_authed.tsx` answers `NoClubScreen` for every route when `clubs` is empty,
 * because the workspace nav dead-ends into empty pages (#267). Two kinds of
 * club-less person have a page that needs no club:
 *
 * - an Area Director (a current term, #1116), at `/area/<id>`;
 * - a platform superadmin, at `/superadmin` and below. Before this, the
 *   club-less "Go to Superadmin" button landed on `NoClubScreen` again.
 *
 * Everyone else, and every other path, keeps `NoClubScreen`.
 *
 * This is the layout's CHOICE of frame, not an authorization. Each page behind
 * it keeps its own gate (`requireAreaDirector`, `requireSuperadmin`), so a
 * wrong answer here shows the wrong frame and never grants a read.
 *
 * Pure and client-safe: no `#/db`, no server import.
 */
export interface ClublessWho {
	/** The person has at least one current Area Director term. */
	hasAreas: boolean;
	isSuperadmin: boolean;
}

/** True when `pathname` is `base` itself or anything beneath it. */
function isUnder(pathname: string, base: string): boolean {
	return pathname === base || pathname.startsWith(`${base}/`);
}

/** Whether a club-less `who` is shown the page at `pathname`, not `NoClubScreen`. */
export function clublessMayOpen(pathname: string, who: ClublessWho): boolean {
	if (who.hasAreas && pathname.startsWith("/area/")) return true;
	if (who.isSuperadmin && isUnder(pathname, "/superadmin")) return true;
	return false;
}
