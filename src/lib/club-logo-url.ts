/**
 * Pure URL builder for the public club-logo GET route (#495). No `#/db`
 * import — safe for server AND client code (the agenda-header build and the
 * club-settings preview both call this).
 *
 * The `?v=` param is required, not cosmetic: `public/sw.js`'s
 * `staleWhileRevalidate` matches the request URL exactly (unlike
 * `networkFirst`, which has an `ignoreSearch` fallback), so a fixed logo URL
 * would serve the stale, SW-cached image forever after a replacement.
 */

/**
 * Build the versioned logo URL for a club, or null when the club has no
 * logo. `updatedAt` is the `club_logos.updated_at` value — the cache-buster
 * source — accepted as a `Date`, an ISO string (server fns serialize dates to
 * strings over the wire), or nullish (no logo uploaded).
 */
export function clubLogoUrl(
	clubId: string,
	updatedAt: Date | string | null | undefined,
): string | null {
	if (updatedAt == null) return null;
	const epochMs =
		updatedAt instanceof Date
			? updatedAt.getTime()
			: new Date(updatedAt).getTime();
	if (Number.isNaN(epochMs)) return null;
	return `/api/club/${clubId}/logo?v=${epochMs}`;
}
