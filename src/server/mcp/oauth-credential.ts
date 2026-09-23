/**
 * Verify an OAuth access token for `/api/mcp` (#843 / ADR-0027).
 *
 * The ONLY file under `src/server/mcp/` or the route allowed to import
 * `#/lib/auth`, and the only binding it takes is `auth` — which it hands
 * straight to Better Auth's resource-server wrapper. `mcp-authz.guard.test.ts`
 * holds both halves. The reason is the bearer-only CSRF posture: `#/lib/auth`
 * is where every cookie-reading API lives (`getSession`, `getSessionFromCtx`,
 * `handler`), and an allow-list with one entry fails for a symbol nobody
 * thought of when the guard was written, where a deny-list of names does not.
 *
 * ## What verifies, and what is configuration
 *
 * `requireMcpAuth` verifies the JWT against GavelUp's own JWKS and checks
 * signature, issuer, audience and expiry. The audience is `mcpResourceUrl()` —
 * the same function `auth.ts` gives `mcp()` as the resource it binds tokens to
 * — and the issuer and JWKS URL default to Better Auth's base URL, which is
 * what signs them. So "a token for a different resource is refused" is
 * configuration here, not code this repo wrote; the integration suite proves
 * it with a token signed by the real key and the wrong `aud`.
 *
 * It is `requireMcpAuth` and not `createMcpProtectedRequestHandler` because
 * the former also wires the DPoP replay store to the auth database. Wrapping
 * the ROUTE in it would reject every `tmk_` token, so `handle-request.ts`
 * branches on the prefix first and only the non-`tmk_` path reaches here.
 *
 * ## The JWKS is fetched over HTTP, from this same server
 *
 * Measured against `better-auth@1.7.5`, not assumed: the verifier takes a
 * JWKS URL or a remote-introspection config and nothing else, so it GETs
 * `${BETTER_AUTH_URL}/api/auth/jwks` — out through Railway's edge and back in —
 * and caches the key set for five minutes (`jwksCache` in
 * `@better-auth/core/oauth2/verify`). Two consequences worth knowing:
 *
 * - `BETTER_AUTH_URL` must be the canonical origin. The fetch refuses
 *   redirects, so an `http://` or bare-domain value that 301s makes every
 *   OAuth call fail.
 * - A token naming a `kid` the cache does not hold forces a refetch, and that
 *   fetch is metered by the auth rate limiter like any other `/api/auth`
 *   request. A legitimate token's `kid` is cached, so it is unaffected until
 *   the cache expires.
 *
 * Tests route that one URL to `auth.handler` in-process
 * (`routeJwksToHandler` in `#/test/oauth-flow`); nothing else is stubbed.
 */
import { requireMcpAuth } from "@better-auth/mcp";
import { auth } from "#/lib/auth";
import { mcpResourceUrl } from "#/lib/well-known-forward";
import { grantFromClaims, unauthorizedResponse } from "./oauth-claims";
import type { VerifiedOAuthGrant } from "./tool";

/**
 * Verify the request's access token, then run `handler` with the grant it
 * carries. A missing, malformed, expired, wrong-audience or wrong-issuer
 * token never reaches `handler`: Better Auth answers it with a 401 and an
 * RFC 9728 `WWW-Authenticate` challenge.
 */
export function serveWithOAuthCredential(
	request: Request,
	handler: (request: Request, grant: VerifiedOAuthGrant) => Promise<Response>,
): Promise<Response> {
	return requireMcpAuth(
		auth,
		async (verified, claims) => {
			const grant = grantFromClaims(claims);
			if (!grant) {
				return unauthorizedResponse(
					"That access token was not issued to a person.",
				);
			}
			return handler(verified, grant);
		},
		{ resource: mcpResourceUrl() },
	)(request);
}
