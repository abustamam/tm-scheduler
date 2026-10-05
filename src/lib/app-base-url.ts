// The app's own absolute base URL, for links the server writes into text a
// human will send or open elsewhere (lineup blasts, MCP confirm links). Moved
// out of the reminder unsubscribe-link module when reminder emails were removed
// (#902, ADR-0028); the behaviour is unchanged.

/** Fallback when `BETTER_AUTH_URL` is unset (it is always set in dev/prod; this
 *  only keeps a link absolute in a bare env rather than emitting a useless
 *  relative URL). */
const FALLBACK_BASE_URL = "https://gavelup.app";

/** The app base URL (no trailing slash) for building absolute links. */
export function appBaseUrl(): string {
	const raw = process.env.BETTER_AUTH_URL || FALLBACK_BASE_URL;
	return raw.replace(/\/+$/, "");
}
