// Pure, client-safe club soft-archive check (ADR-0016 / #186). Lives in `src/lib`
// (no `#/db` import) so BOTH the server guard (`src/server/guards.ts`) and the
// client-reachable public-loader helper (`src/lib/club-route.ts`) can import it
// without dragging `pg` → `Buffer` into the client bundle.

/**
 * Whether a club is soft-archived (`archived_at` set). The single reusable
 * archive check. A soft-archived club is inaccessible everywhere except the
 * superadmin console — which includes a read-only impersonation session, the one
 * way the operator who took a club down can still look at it (#560).
 *
 * THE canonical list of enforcement points. Other files point HERE rather than
 * restating it: this claim has now gone stale twice (#544, #560), and each restated
 * copy is another place it can rot independently.
 *
 * Three db-level points, and a route guard is none of them. Labelled by MECHANISM,
 * not by verb — an earlier version of this list said "authed WRITES" for the first
 * one, which is checkably false: GET server fns that gate with `requireClubRole`
 * (e.g. `getScoreboard` in `server/dcp.ts`) reach it too.
 *   - The MEMBERSHIP guards — `requireMembership` / `requireClubRole`
 *     (`server/guards.ts`) via the private `assertClubNotArchived`. Every mutation,
 *     plus the GET fns that still gate this way.
 *   - The READ gates — `requireClubViewAccess` / `requireClubAdminView`, via
 *     `grantView` in the same file. These do NOT go through `requireMembership`;
 *     believing they did is what left an archived club serving its roster's contact
 *     details to its own members until #560.
 *   - PUBLIC, session-less `createServerFn` readers — `isReadableClub` /
 *     `isReadableClubForMeeting` / `isReadableClubForMember` in
 *     `server/club-readable-logic.ts`.
 *
 * Authed readers that resolve membership with a bare `getMembership` reach NONE of
 * them and must call a public seam themselves: `minutes.ts`, the minutes-PDF API
 * route and `my-activity-logic.ts` were each doing this until #560.
 *
 * Public no-auth club loaders (landing, present, print, and the #208 guest-book)
 * must treat an archived club as not-found.
 *
 * Router loaders reached through the `/club/$clubId` shell also funnel through
 * `resolveClubOrRedirect`, which calls this. But that guards the CALLER, not the
 * endpoint: a `createServerFn` is addressable directly with no session and no
 * router, so "route it through the shell" is not a gate. Believing otherwise is
 * exactly what left fourteen public readers open until #544 — do not repeat it.
 */
export function isClubArchived(club: { archivedAt: Date | null }): boolean {
	return club.archivedAt != null;
}
