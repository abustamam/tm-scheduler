// Active-club selection (issue #10). The user↔club link is many-to-many
// (ADR-0006); this resolves which of their clubs the workspace is currently
// acting in. Pure + client-safe (no db) so it's directly unit-testable and the
// cookie plumbing in auth-context.ts stays thin.

/** Cookie name persisting the user's chosen active club across reloads. */
export const ACTIVE_CLUB_COOKIE = "active_club";

/**
 * Which of the user's clubs is active: the cookie's club when they're still an
 * active member of it, otherwise their first club (a stable, name-ordered
 * default). Returns null only when they belong to no clubs.
 *
 * Filtering the cookie against current memberships means a stale or forged
 * cookie can never pin the workspace to a club the user isn't in — it silently
 * falls back to the default.
 */
export function resolveActiveClubId(
	memberClubIds: readonly string[],
	cookieClubId: string | null | undefined,
): string | null {
	if (cookieClubId && memberClubIds.includes(cookieClubId)) {
		return cookieClubId;
	}
	return memberClubIds[0] ?? null;
}
