/** Pure helpers for the offline "available offline / last saved" indicator. */

const OFFLINE_VISIT_PREFIX = "gavelup-offline-visit:";

/** localStorage key holding the last time `id` was loaded while online. */
export function offlineVisitKey(id: string): string {
	return `${OFFLINE_VISIT_PREFIX}${id}`;
}

/**
 * A short, human "as of" label for a cached timestamp, relative to `now`.
 * Falls back to a locale date once the copy is more than a day old.
 */
export function relativeTime(ts: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - ts) / 1000));
	if (seconds < 60) return "just now";

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

	return new Date(ts).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}
