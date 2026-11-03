/**
 * A cap on how often GavelUp fetches a CIMD client's JWKS (#1486).
 *
 * ChatGPT authenticates at the token endpoint with `private_key_jwt`, so the
 * provider fetches its keys from the `jwks_uri` in its metadata document. When
 * no cached key matches an assertion's `kid`, the provider fetches them AGAIN
 * (`refetchClientJwks` in `@better-auth/oauth-provider`), before it checks the
 * signature and outside the CIMD plugin's own fetch budget. Anyone can send
 * such an assertion, so without this, every junk token request becomes a
 * request from GavelUp to chatgpt.com, and enough of them get GavelUp
 * throttled there and break real connections.
 *
 * Wrapped around the CIMD transport in `src/lib/auth.ts`, this lets each JWKS
 * URL be fetched at most once per {@link JWKS_MIN_INTERVAL_MS}; a fetch inside
 * that window throws, which the provider turns into `invalid_client` (or
 * answers from its own cache). A real key rotation is picked up within the
 * window. The window starts when a fetch STARTS, so concurrent refetches are
 * throttled too. Metadata documents (the allowlisted client ids) pass
 * through untouched: the plugin budgets those itself.
 */

/** The shape of the CIMD transport (`ClientMetadataResourceFetch`). */
type Fetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Response | Promise<Response>;

/** One JWKS fetch per URL per minute. */
export const JWKS_MIN_INTERVAL_MS = 60_000;

export function throttleJwksFetches<F extends Fetch>(
	fetch: F,
	isMetadataDocument: (url: string) => boolean,
	now: () => number = Date.now,
): F {
	const lastStarted = new Map<string, number>();
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (isMetadataDocument(url)) return fetch(input, init);
		const at = now();
		const last = lastStarted.get(url);
		if (last !== undefined && at - last < JWKS_MIN_INTERVAL_MS) {
			throw new TypeError("JWKS refetch throttled");
		}
		lastStarted.set(url, at);
		return fetch(input, init);
	}) as F;
}
