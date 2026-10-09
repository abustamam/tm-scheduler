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
 * Everyone else, and every other page, keeps `NoClubScreen`.
 *
 * DECIDED ON THE MATCHED ROUTES, not the URL's text. The router matches paths
 * case-insensitively, so `/AREA/<id>` and `/Superadmin` are the same pages as
 * `/area/<id>` and `/superadmin`; a `startsWith` on the raw pathname would show
 * those `NoClubScreen` while the page behind them was allowed. The route ids
 * below are what the router matched, whatever the casing, and a look-alike
 * (`/areaX`, `/superadmin-foo`, `/area` with no id) matches none of them.
 * `authed-clubless.test.tsx` holds each id to its route file's own `id`.
 *
 * This is the layout's CHOICE of frame, not an authorization. Each page behind
 * it keeps its own gate (`requireAreaDirector`, `requireSuperadmin`), so a
 * wrong answer here shows the wrong frame and never grants a read.
 *
 * Pure and client-safe: no `#/db`, no server import.
 */

/** `src/routes/_authed/area/$areaId.tsx`. */
export const AREA_ROUTE_ID = "/_authed/area/$areaId";

/** `src/routes/_authed/superadmin.tsx`, the layout over every console page. It
 *  is a match for each of them, so no child id needs listing. */
export const SUPERADMIN_ROUTE_ID = "/_authed/superadmin";

export interface ClublessWho {
	/** The person has at least one current Area Director term. */
	hasAreas: boolean;
	isSuperadmin: boolean;
}

/**
 * Whether a club-less `who` is shown the page the router matched, not
 * `NoClubScreen`. `routeIds` is the id of every match, parents included
 * (`state.matches.map((m) => m.routeId)`).
 */
export function clublessMayOpen(
	routeIds: readonly string[],
	who: ClublessWho,
): boolean {
	if (who.hasAreas && routeIds.includes(AREA_ROUTE_ID)) return true;
	if (who.isSuperadmin && routeIds.includes(SUPERADMIN_ROUTE_ID)) return true;
	return false;
}
