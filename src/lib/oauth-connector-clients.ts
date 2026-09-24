/**
 * Which apps may identify themselves to GavelUp by URL (#852 / ADR-0027).
 *
 * A Client ID Metadata Document (CIMD) client needs no registration: it sends
 * an `https://` URL as its `client_id`, and the provider fetches the document
 * at that URL to learn its name and redirect URIs. Left open, that is a
 * public "fetch any URL and mint a client row from it" endpoint, and every
 * consent screen would then name whatever an arbitrary document claimed.
 *
 * So the plugin's pre-fetch hook (`src/lib/auth.ts`) admits only these URLs,
 * by EXACT string match. Not a prefix and not an origin: `claude.ai` hosts
 * more than one document, and only one of them is meant to reach this server.
 */

/**
 * The only Client ID Metadata Document URLs GavelUp will fetch. Hosted Claude
 * only (web, desktop, mobile): Claude Code keeps using personal `tmk_` tokens,
 * and its own CIMD document declares loopback redirects.
 *
 * Adding a client is one entry here plus a fixture test beside the Claude one
 * in `src/routes/oauth-consent.integration.test.ts`. A refused id is logged
 * (`logRefusedCimdClient`), which is how the next client's URL is found.
 */
export const CIMD_ALLOWED_CLIENT_IDS: ReadonlySet<string> = new Set([
	"https://claude.ai/oauth/mcp-oauth-client-metadata",
]);

/** The longest slice of a refused client id that reaches the log. */
const REFUSED_ID_LOG_LIMIT = 512;

/**
 * The CIMD pre-fetch gate: `true` only for an allowlisted client id.
 *
 * A refusal is logged once per call at info level. The id is caller-supplied,
 * so it is truncated and JSON-quoted — a newline in it cannot forge a second
 * log line — and it carries no user data.
 */
export function isCimdClientIdAllowed(clientIdUrl: string): boolean {
	if (CIMD_ALLOWED_CLIENT_IDS.has(clientIdUrl)) return true;
	console.info(
		"[oauth] refused CIMD client_id",
		JSON.stringify(clientIdUrl.slice(0, REFUSED_ID_LOG_LIMIT)),
	);
	return false;
}

/**
 * The consent endpoint's refusal when a non-officer presses Approve, and the
 * words for it. Shared by the hook in `src/lib/auth.ts` that sends it and
 * `/oauth/consent`, which shows the same sentence whether it learned the rule
 * from its loader (`eligible: false`) or from this refusal.
 */
export const NOT_AN_OFFICER = "not_an_officer";
export const NOT_AN_OFFICER_MESSAGE =
	"Only club officers can connect apps right now.";
