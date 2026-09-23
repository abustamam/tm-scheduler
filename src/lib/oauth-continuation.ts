/**
 * Turning the OAuth provider's sign-in and consent redirects back into
 * something this app can act on (#843 / ADR-0027). Client-safe: it imports
 * only `zod` and the path constants.
 *
 * ## What the provider actually sends, which is not `?redirect=`
 *
 * Measured against `@better-auth/oauth-provider@1.7.5`: an authorize request
 * with no session is sent to `/signin?<the authorize query>` and one needing
 * consent to `/oauth/consent?<the same>`, each with five extra parameters —
 * `exp`, `ba_iat`, `sig`, a REPEATED `ba_param` naming the signed keys, and
 * sometimes `ba_pl`. The signature covers the query byte-for-byte.
 *
 * ## Why the pages read `window.location.search`, never the router's search
 *
 * TanStack Router re-serialises search on the server and 307s to the result
 * whenever `validateSearch` changes it — measured on this app: a repeated
 * `ba_param=a&ba_param=b` came back as `ba_param=%5B%22a%22%2C%22b%22%5D`, and
 * any numeric-looking value is parsed as a number first. Either breaks the
 * signature, and the provider then refuses the consent with `invalid_signature`.
 * So `/signin` and `/oauth/consent` add nothing to their search (no 307), and
 * both read the raw string off `window.location` at the moment they need it.
 */
import { z } from "zod";
import { AUTH_BASE_PATH } from "#/lib/well-known-forward";

/**
 * What `/oauth/consent` needs from its query to render a decision, checked
 * against the router's PARSED search (which is fine for this: nothing here is
 * sent back). `sig` is required because a query without one is not a prompt
 * the provider sent, and posting it would fail anyway.
 */
const consentQuerySchema = z.object({
	client_id: z.string().min(1).max(256),
	sig: z.string().min(1),
	scope: z.string().optional(),
});

export type ConsentQuery =
	| { ok: true; clientId: string; scopes: string[] }
	| { ok: false };

/** Validate a consent visit's query; a malformed one renders an error, never throws. */
export function parseConsentQuery(
	search: Record<string, unknown>,
): ConsentQuery {
	const parsed = consentQuerySchema.safeParse(search);
	if (!parsed.success) return { ok: false };
	return {
		ok: true,
		clientId: parsed.data.client_id,
		scopes: (parsed.data.scope ?? "").split(" ").filter(Boolean),
	};
}

/**
 * The signed query to post back as `oauth_query`, from the URL the browser is
 * actually on. `search` is `window.location.search`, leading `?` and all.
 */
export function oauthQueryFromLocation(search: string): string {
	return search.startsWith("?") ? search.slice(1) : search;
}

/** The parameters the provider adds to sign its redirect. */
const SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

/**
 * True when a query string is a signed OAuth prompt from the provider, rather
 * than an ordinary visit.
 */
export function isSignedOAuthQuery(search: string): boolean {
	const params = new URLSearchParams(search);
	return Boolean(params.get("sig") && params.get("client_id"));
}

/**
 * The same test against the router's PARSED search, for `validateSearch`,
 * which never sees the raw string. Same rule: a non-empty `sig` and a
 * non-empty `client_id`. The router parses an all-digit value as a number,
 * so a client id is accepted as either.
 */
export function isSignedOAuthSearch(search: Record<string, unknown>): boolean {
	const { sig, client_id: clientId } = search;
	return (
		typeof sig === "string" &&
		sig.length > 0 &&
		((typeof clientId === "string" && clientId.length > 0) ||
			typeof clientId === "number")
	);
}

/** The authorize endpoint a continuation replays. */
const AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`;

/** True when a `/signin` redirect target is an OAuth continuation. */
export function isOAuthAuthorizeTarget(target: string | undefined): boolean {
	return target?.startsWith(`${AUTHORIZE_PATH}?`) ?? false;
}

/**
 * The authorize URL that resumes an OAuth flow once the person has signed in,
 * or null when `search` is not a signed OAuth prompt.
 *
 * The provider's signed parameters are dropped and the ORIGINAL authorize
 * request is replayed: with a session now present, authorize moves on to
 * consent and signs a fresh query for it. That is also what makes the
 * cross-device case work — a magic link opened in a second browser carries
 * this URL as its callback, so the flow resumes wherever the link is opened,
 * under whichever session that browser now has.
 *
 * Replaying the request can do no more than the authorize URL itself, which
 * anyone could already send someone: authorize re-validates the client and
 * its registered redirect URIs, a client the person has not approved still
 * stops at consent, and a code only ever goes to a registered redirect URI.
 */
export function oauthAuthorizeContinuation(search: string): string | null {
	if (!isSignedOAuthQuery(search)) return null;
	const params = new URLSearchParams(search);
	for (const name of SIGNATURE_PARAMS) params.delete(name);
	// Never part of an authorize request; it is `/signin`'s own parameter.
	params.delete("redirect");
	dropSatisfiedReauthentication(params);
	return `${AUTHORIZE_PATH}?${params.toString()}`;
}

/**
 * Remove the parts of the request that demand a FRESH sign-in —
 * `prompt=login`, `prompt=create`, and `max_age` — because by the time the
 * continuation runs, one has just happened.
 *
 * Without this the flow loops: the replayed authorize still says
 * `prompt=login`, the provider sends the now signed-in person back to
 * `/signin`, another magic link goes out, and so on until the magic-link rate
 * limit stops it (reproduced against the installed provider by two review
 * passes). The provider's own resume path drops the same three — after
 * checking the session is newer than the signed `ba_iat` — and this path
 * throws `ba_iat` away with the signature.
 *
 * Dropping them from an UNSIGNED query is safe for the one reason that
 * matters: a continuation is only ever the callback of a magic link, so it
 * runs immediately after the person proved control of their inbox, which is
 * exactly what `prompt=login` and `max_age` ask for. Other prompt values
 * (`consent`, `select_account`) are left alone.
 */
function dropSatisfiedReauthentication(params: URLSearchParams): void {
	params.delete("max_age");
	const prompt = params.get("prompt");
	if (prompt === null) return;
	const kept = prompt
		.split(" ")
		.filter((value) => value && value !== "login" && value !== "create");
	if (kept.length > 0) params.set("prompt", kept.join(" "));
	else params.delete("prompt");
}
