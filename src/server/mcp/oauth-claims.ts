/**
 * The pure half of `/api/mcp`'s OAuth credential (#843): the forged-`kid`
 * gate, turning verified claims into a grant, and the RFC 9728 challenge
 * every 401 carries.
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
 *
 * The body is the JSON-RPC error envelope Better Auth's resource-server
 * handler sends for its own refusals (`@better-auth/mcp`'s
 * `toChallengeResponse`), so every 401 on this endpoint has ONE shape whichever
 * branch refused it. Before #843 the `tmk_` branch answered `{ error }`; no
 * client read that body, and an MCP client reads the envelope.
 */
export function unauthorizedResponse(message: string): Response {
	return Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message }, id: null },
		{ status: 401, headers: { "WWW-Authenticate": bearerChallenge() } },
	);
}

/**
 * The access token in an `Authorization` header, under either scheme the
 * verifier accepts (RFC 6750 `Bearer`, RFC 9449 `DPoP`), or null.
 */
export function accessTokenFrom(header: string | null): string | null {
	const match = /^(?:Bearer|DPoP)\s+(\S+)$/i.exec(header?.trim() ?? "");
	return match?.[1] ?? null;
}

/**
 * What a JWS's protected header says about its key, read without verifying
 * anything.
 *
 * A DISCRIMINATED result, never a bare string: the first version returned the
 * words `"absent"` and `"malformed"` as sentinels beside real key ids, so a
 * token whose literal `kid` WAS `"absent"` walked straight past the gate and
 * every such request cost a JWKS fetch again (Codex's re-review, #843).
 */
export type JwsKey =
	| { kind: "kid"; kid: string }
	| { kind: "no-kid" }
	| { kind: "malformed" };

export function jwsKey(token: string): JwsKey {
	const parts = token.split(".");
	const header = parts[0];
	if (parts.length !== 3 || !header) return { kind: "malformed" };
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(header, "base64url").toString("utf8"),
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { kind: "malformed" };
		}
		const { kid } = parsed as { kid?: unknown };
		if (kid === undefined) return { kind: "no-kid" };
		return typeof kid === "string" && kid.length > 0
			? { kind: "kid", kid }
			: { kind: "malformed" };
	} catch {
		return { kind: "malformed" };
	}
}

/**
 * How long the known key set is trusted, and the least time between two
 * reloads an unknown `kid` can force. The cooldown is the denial-of-service
 * fix: at 0 every junk token costs a load again. `oauth-credential.test.ts`
 * bounds both against ABSOLUTE numbers, not against these constants.
 */
export const KID_GATE_TTL_MS = 5 * 60 * 1000;
export const KID_GATE_MISS_COOLDOWN_MS = 30 * 1000;

export interface KidGateOptions {
	/** How long a loaded key set is trusted before it is reloaded. */
	ttlMs?: number;
	/** The least time between two reloads forced by an unknown `kid`. */
	missCooldownMs?: number;
	now?: () => number;
}

/**
 * Refuse an access token whose `kid` is not one of GavelUp's signing keys,
 * BEFORE the library verifier sees it.
 *
 * Why this exists, measured against `@better-auth/core@1.7.5`
 * (`oauth2/verify`): the verifier refetches the JWKS on every `kid` its cache
 * does not hold, with no cooldown, before it checks a signature. It fetches
 * over HTTP from this same server, and those self-fetches all arrive from the
 * server's own egress address — one rate-limit bucket, 20 a minute. So ~21
 * anonymous requests a minute, each a junk JWT with a random `kid`, kept that
 * bucket empty, and the next legitimate refresh (every five minutes, or after
 * a key rotation) failed: every claude.ai call answered 500. Four independent
 * review passes found it.
 *
 * The known key ids come from `loadKids`, which reads the key set IN PROCESS
 * — no HTTP, no rate limiter. An unknown `kid` forces at most one reload per
 * `missCooldownMs`, so a flood costs one database read every thirty seconds,
 * and a token that is not a well-formed JWS is refused without one,
 * and a real key rotation is picked up within that window. Concurrent reloads
 * share one promise. A failed load throws: it is our outage, not the caller's
 * bad token, and `handle-request` answers it with a 500 rather than a 401
 * that would send claude.ai back through consent.
 */
export function createKidGate(
	loadKids: () => Promise<readonly string[]>,
	options: KidGateOptions = {},
): { admits: (token: string) => Promise<boolean> } {
	const ttlMs = options.ttlMs ?? KID_GATE_TTL_MS;
	const missCooldownMs = options.missCooldownMs ?? KID_GATE_MISS_COOLDOWN_MS;
	const now = options.now ?? Date.now;
	let known: { kids: ReadonlySet<string>; loadedAt: number } | null = null;
	let inFlight: Promise<ReadonlySet<string>> | null = null;

	const reload = (): Promise<ReadonlySet<string>> => {
		inFlight ??= loadKids()
			.then((kids) => {
				const set = new Set(kids);
				known = { kids: set, loadedAt: now() };
				return set;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};

	return {
		admits: async (token) => {
			const key = jwsKey(token);
			// Not a JWS this server could have issued: refused here, so there is
			// no parser difference between this gate and the verifier's for a
			// caller to aim at. GavelUp's access tokens always name their key.
			if (key.kind === "malformed") return false;
			// A well-formed header with no `kid`: the verifier selects the key
			// itself and applies its own thirty-second refetch cooldown.
			if (key.kind === "no-kid") return true;
			const { kid } = key;
			const current = known;
			if (!current || now() - current.loadedAt >= ttlMs) {
				return (await reload()).has(kid);
			}
			if (current.kids.has(kid)) return true;
			if (now() - current.loadedAt < missCooldownMs) return false;
			return (await reload()).has(kid);
		},
	};
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
