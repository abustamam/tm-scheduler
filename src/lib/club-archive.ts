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
 * Public loaders funnel through `resolveClubOrRedirect`, which calls this; ANY
 * new public club loader MUST call it too (directly or via that helper).
 */
export function isClubArchived(club: { archivedAt: Date | null }): boolean {
	return club.archivedAt != null;
}
