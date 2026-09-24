// First-touch marketing attribution (#866). Client-safe: no `#/db`.
//
// A share link carries `?ref=<slug>` (e.g. `?ref=district-57`). The first
// marketing page the visitor lands on stores it for the tab, and the
// request-access form sends it with the submission, so a lead from a
// particular push is recognisable in the table.
//
// Session storage, not local: attribution is per visit, and a ref that
// outlived the tab would credit a push for a later, unrelated visit.

/**
 * What a `ref` may be. The server's input schema and the share-link builder
 * both use this, so a ref the link builder mints is one the server keeps.
 */
export const REF_PATTERN = /^[a-z0-9-]{1,64}$/;

/** The session-storage key the captured ref lives under. */
export const REF_STORAGE_KEY = "gavelup.ref";

export function isValidRef(ref: string): boolean {
	return REF_PATTERN.test(ref);
}

/**
 * Store `?ref=` from a raw query string, if it is valid and nothing is stored
 * yet: FIRST touch wins, so a later link in the same tab does not re-credit.
 *
 * Takes the raw `window.location.search`, not the router's parsed search — a
 * marketing route that declared `ref` in `validateSearch` would 307 a URL whose
 * search it rewrote (CLAUDE.md's validateSearch pitfall).
 *
 * A no-op on the server, and every storage access is wrapped: private mode and
 * blocked site data make `sessionStorage` throw, and attribution is never worth
 * breaking a page for.
 */
export function captureRef(search: string): void {
	if (typeof window === "undefined") return;
	try {
		const ref = new URLSearchParams(search).get("ref");
		if (ref === null || !isValidRef(ref)) return;
		const storage = window.sessionStorage;
		if (storage.getItem(REF_STORAGE_KEY) !== null) return;
		storage.setItem(REF_STORAGE_KEY, ref);
	} catch {
		// Storage unavailable: attribution is best-effort.
	}
}

/** The captured ref for this tab, or null (none, invalid, or no storage). */
export function readRef(): string | null {
	if (typeof window === "undefined") return null;
	try {
		const ref = window.sessionStorage.getItem(REF_STORAGE_KEY);
		return ref !== null && isValidRef(ref) ? ref : null;
	} catch {
		return null;
	}
}
