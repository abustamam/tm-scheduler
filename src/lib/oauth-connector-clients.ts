/**
 * Which apps may identify themselves to GavelUp by URL (#852 / ADR-0027).
 *
 * A Client ID Metadata Document (CIMD) client needs no registration: it sends
 * an `https://` URL as its `client_id`, and the provider fetches the document
 * at that URL to learn its name and redirect URIs. Left open, that is a
 * public "fetch any URL and mint a client row from it" endpoint, and every
 * consent screen would then name whatever an arbitrary document claimed.
 *
 * So only these URLs are admitted, by EXACT string match. Not a prefix and not
 * an origin: `claude.ai` hosts more than one document, and only one of them is
 * meant to reach this server. Two places apply it, both in `src/lib/auth.ts`:
 *
 * - a `hooks.before` that refuses a request naming any other `https://`
 *   client id ({@link unlistedCimdClientId}) BEFORE the provider resolves the
 *   client, so an unlisted id never reaches the plugin's metadata resolver or
 *   its fetch limits at all;
 * - the plugin's own `isMetadataDocumentUrlAllowed` pre-fetch hook, the same
 *   predicate, as the second line should a request reach resolution by a path
 *   the first does not read.
 *
 * This module is imported by `/oauth/consent` for the refusal code, so it
 * stays free of server imports.
 */

/**
 * The only Client ID Metadata Document URLs GavelUp will fetch. Hosted Claude
 * only (web, desktop, mobile): Claude Code keeps using personal `tmk_` tokens,
 * and its own CIMD document declares loopback redirects.
 *
 * Adding a client is one entry here plus a fixture test beside the Claude one
 * in `src/routes/oauth-consent.integration.test.ts`. A refused id is logged
 * (by {@link isCimdClientIdAllowed}), which is how the next client's URL is
 * found.
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
 * Whether a client id is one the CIMD plugin would try to resolve by URL.
 * Mirrors `isCimdClientIdUrlCandidate` in `@better-auth/cimd` (an `https:`
 * URL), restated here because importing that package would pull the provider
 * into the client bundle this module is part of.
 */
function isUrlClientId(clientId: string): boolean {
	try {
		return new URL(clientId).protocol === "https:";
	} catch {
		return false;
	}
}

/** The `iss` and `sub` of a JWT's payload, unverified; nothing on failure. */
function assertionSubjects(assertion: unknown): string[] {
	if (typeof assertion !== "string") return [];
	const payload = assertion.split(".")[1];
	if (!payload) return [];
	try {
		const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
		const claims = JSON.parse(json) as { iss?: unknown; sub?: unknown };
		return [claims.iss, claims.sub].filter(
			(v): v is string => typeof v === "string",
		);
	} catch {
		return [];
	}
}

/** The client id in an `Authorization: Basic` header, if there is one. */
function basicAuthClientId(authorization: string | null | undefined): string[] {
	const match = /^basic\s+(\S+)$/i.exec(authorization ?? "");
	if (!match?.[1]) return [];
	try {
		const decoded = atob(match[1]);
		const colon = decoded.indexOf(":");
		return [
			decodeURIComponent(colon === -1 ? decoded : decoded.slice(0, colon)),
		];
	} catch {
		return [];
	}
}

/** Where a client id can arrive on a provider request. */
export interface ClientIdSources {
	query?: Record<string, unknown> | null;
	body?: unknown;
	params?: Record<string, unknown> | null;
	authorization?: string | null;
}

/**
 * The first URL-shaped client id a request names that is NOT allowlisted, or
 * null. Reads every place the provider takes a client id from before it
 * resolves the client: `client_id` in the query, the body or a path parameter;
 * the user part of `Authorization: Basic`; and the `iss` / `sub` of a
 * `client_assertion`. A refusal is logged once, by `isCimdClientIdAllowed`.
 *
 * Only URL-shaped ids are judged. A hand-registered client's opaque id is not
 * a metadata document and passes through to the provider untouched.
 */
export function unlistedCimdClientId(sources: ClientIdSources): string | null {
	const body =
		sources.body && typeof sources.body === "object"
			? (sources.body as Record<string, unknown>)
			: {};
	const candidates = [
		sources.query?.client_id,
		body.client_id,
		sources.params?.client_id,
		...basicAuthClientId(sources.authorization),
		...assertionSubjects(sources.query?.client_assertion),
		...assertionSubjects(body.client_assertion),
	];
	const seen = new Set<string>();
	for (const id of candidates) {
		if (typeof id !== "string" || seen.has(id)) continue;
		seen.add(id);
		if (isUrlClientId(id) && !isCimdClientIdAllowed(id)) return id;
	}
	return null;
}

/**
 * The consent endpoint's refusal when a non-officer presses Approve, and the
 * one sentence for it: the hook in `src/lib/auth.ts` sends it as the
 * `error_description`, and `/oauth/consent` shows it whether it learned the
 * rule from its loader (`eligible: false`) or from this refusal.
 */
export const NOT_AN_OFFICER = "not_an_officer";
export const NOT_AN_OFFICER_MESSAGE =
	"Only club officers can connect apps to GavelUp right now.";
