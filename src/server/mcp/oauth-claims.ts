/**
 * The pure half of `/api/mcp`'s OAuth credential (#843): turning verified
 * claims into a grant, and the RFC 9728 challenge every 401 carries.
 *
 * Split from `oauth-credential.ts` so it can be tested without loading
 * `#/lib/auth` — which opens a database pool and seeds a row at import — and
 * so the one file allowed to import that module stays the size of the one
 * thing it does.
 */
import { mcpResourceUrl } from "#/lib/well-known-forward";
import type { VerifiedOAuthGrant } from "./tool";

/**
 * The protected-resource metadata document for a resource, per RFC 9728 §3.1:
 * the well-known name inserted between the resource's origin and its path.
 *
 * `src/routes/[.]well-known.$.ts` forwards exactly this path (it is one of the
 * four in `well-known-forward`'s allowlist), and
 * `mcp-route.integration.test.ts` fetches the URL a real challenge names — a
 * challenge pointing at a 404 is how a connector dead-ends with no diagnosis.
 */
export function protectedResourceMetadataUrl(
	resource: string = mcpResourceUrl(),
): string {
	const url = new URL(resource);
	const path = url.pathname.endsWith("/")
		? url.pathname.slice(0, -1)
		: url.pathname;
	return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * The `WWW-Authenticate` value for a 401 on `/api/mcp`.
 *
 * Better Auth builds this header itself for every OAuth-branch refusal. The
 * `tmk_` branch refuses in this repo's code, so it needs the same value built
 * here — and the integration suite asserts the two are byte-identical, so a
 * library change to the format fails a test rather than leaving the two
 * branches advertising different things.
 */
export function bearerChallenge(): string {
	return `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`;
}

/**
 * A 401 that tells an MCP client where to go and authorize.
 *
 * Every 401 this endpoint sends carries the header, including the `tmk_` ones.
 * A `tmk_` client ignores it; an OAuth client that got a bare 401 has nothing
 * to act on, and the claude.ai connect flow stops there.
 */
export function unauthorizedResponse(message: string): Response {
	return Response.json(
		{ error: message },
		{ status: 401, headers: { "WWW-Authenticate": bearerChallenge() } },
	);
}

/**
 * The grant a verified access token carries, or null if it is not one a USER
 * holds.
 *
 * Called only with claims whose signature, issuer, audience and expiry Better
 * Auth has already checked. What is left to check is shape: `sub` names the
 * user (an access token from a client-credentials grant would carry the
 * client's id there instead, and would then fail the user lookup — but it
 * should not get that far), and `jti` / `client_id` are what the
 * `McpCredential` records.
 */
export function grantFromClaims(
	claims: Readonly<Record<string, unknown>>,
): VerifiedOAuthGrant | null {
	const { sub, jti } = claims;
	const clientId = claims.client_id ?? claims.azp;
	if (typeof sub !== "string" || sub.length === 0) return null;
	if (typeof clientId !== "string" || clientId.length === 0) return null;
	if (typeof jti !== "string" || jti.length === 0) return null;
	// A client-credentials token is issued to the client, so its subject IS the
	// client. There is no person behind it to credit a write to.
	if (sub === clientId) return null;
	return { userId: sub, clientId, tokenId: jti };
}
