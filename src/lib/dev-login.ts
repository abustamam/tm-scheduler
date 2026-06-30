/**
 * Dev-only login helper for local automated/manual e2e against a seeded DB.
 *
 * SECURITY: this is a sign-in bypass. It is inert unless BOTH conditions hold:
 *   - NODE_ENV !== "production", AND
 *   - ENABLE_DEV_LOGIN === "1"
 * The `/api/dev-login` route 404s when `isDevLoginEnabled()` is false, and a
 * test (`dev-login.test.ts`) guards that it can never be on in production.
 *
 * Mechanism (see `src/routes/api/dev-login.ts`): we issue a real magic link
 * server-side and redirect the browser to Better-Auth's own verify endpoint,
 * which sets the session cookie. We never mint or sign cookies ourselves. To
 * complete sign-in without a real inbox, `auth.ts`'s `sendMagicLink` stashes
 * the generated URL here (only when dev-login is enabled).
 */
export function isDevLoginEnabled(): boolean {
	return (
		process.env.NODE_ENV !== "production" &&
		process.env.ENABLE_DEV_LOGIN === "1"
	);
}

const pendingLinks = new Map<string, string>();

/** Stash the most recent magic-link URL for an email (dev-login only). */
export function captureDevMagicLink(email: string, url: string): void {
	pendingLinks.set(email.toLowerCase(), url);
}

/** Consume (read + clear) the captured magic-link URL for an email. */
export function takeDevMagicLink(email: string): string | undefined {
	const key = email.toLowerCase();
	const url = pendingLinks.get(key);
	pendingLinks.delete(key);
	return url;
}
