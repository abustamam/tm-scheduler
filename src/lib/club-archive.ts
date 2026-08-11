// Pure, client-safe club soft-archive check (ADR-0016 / #186). Lives in `src/lib`
// (no `#/db` import) so BOTH the server guard (`src/server/guards.ts`) and the
// client-reachable public-loader helper (`src/lib/club-route.ts`) can import it
// without dragging `pg` → `Buffer` into the client bundle.

/**
 * Whether a club is soft-archived (`archived_at` set). The single reusable
 * archive check. A soft-archived club is inaccessible everywhere except the
 * superadmin console:
 *   - authed access is rejected by `requireMembership` (the one choke point
 *     `requireClubRole` builds on), and
 *   - every public no-auth club loader (landing, present, print, and the #208
 *     guest-book) must treat it as not-found.
 * There are TWO db-level enforcement points, and a route guard is neither:
 *   - AUTHED — `requireMembership` (`server/guards.ts`) via `assertClubNotArchived`.
 *   - PUBLIC, session-less `createServerFn` readers — `isReadableClub` /
 *     `isReadableClubForMeeting` / `isReadableClubForMember` in
 *     `server/club-readable-logic.ts`.
 *
 * Router loaders reached through the `/club/$clubId` shell also funnel through
 * `resolveClubOrRedirect`, which calls this. But that guards the CALLER, not the
 * endpoint: a `createServerFn` is addressable directly with no session and no
 * router, so "route it through the shell" is not a gate. Believing otherwise is
 * exactly what left nine public readers open until #544 — do not repeat it.
 */
export function isClubArchived(club: { archivedAt: Date | null }): boolean {
	return club.archivedAt != null;
}
