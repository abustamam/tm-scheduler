/**
 * Serve the two OAuth discovery documents at the ORIGIN ROOT (#842 / ADR-0027).
 *
 * Better Auth is mounted at `/api/auth` (`src/routes/api/auth/$.ts`), and an
 * OAuth client discovers an authorization server at the origin root — RFC 8414
 * for `oauth-authorization-server`, RFC 9728 for `oauth-protected-resource`.
 * `src/routes/api/auth/$.ts` catches `/api/auth/*` and nothing else, so both
 * root URLs 404 without this route.
 *
 * ## Why this forwards instead of rebuilding the documents
 *
 * The bodies are the provider's to write: they name its endpoints, its
 * supported grants, its signing algorithms, and whether DCR is on. Restating
 * any of that here would be a second source of truth that goes stale on a
 * library bump — and the one key that MUST stay absent, `registration_endpoint`,
 * would then be absent because this file forgot it rather than because the
 * provider has DCR off. So the request is rewritten and handed to
 * `auth.handler`, and what it answers is what ships.
 *
 * ## Where Better Auth actually serves them, which is not where it looks
 *
 * Verified by reading the installed 1.7.5 plugins and confirmed by probe, since
 * both documents are served from plugin `onRequest` hooks that match on the
 * FULL request pathname — `auth.handler` runs those hooks before it routes, so
 * it answers paths that are nowhere near its own base path:
 *
 * - `@better-auth/oauth-provider` matches the authorization-server metadata at
 *   `/.well-known/oauth-authorization-server<issuerPath>` and at
 *   `<issuerPath>/.well-known/oauth-authorization-server`, where `issuerPath`
 *   is the issuer's path — `/api/auth` here. The BARE root path is in neither
 *   set, which is the whole reason a rewrite is needed rather than a pass-through.
 * - `@better-auth/mcp` matches the protected-resource metadata at the bare
 *   `/.well-known/oauth-protected-resource` and at that path with the MCP
 *   resource's own path appended. Those are already root paths, so they forward
 *   unchanged.
 *
 * The authorization-server rewrite targets the base-path form
 * (`/api/auth/.well-known/…`) rather than the issuer-inserted form, because two
 * independent mechanisms answer it — the `onRequest` hook above AND the
 * provider's registered `getOAuthServerConfig` endpoint, which is a real route
 * under the base path. The issuer-inserted form relies on the hook alone.
 *
 * ## Why an allowlist and not a catch-all
 *
 * A splat route answers for every `.well-known` path under the origin. Handing
 * all of them to `auth.handler` would make this file quietly responsible for
 * whatever future path a plugin decides to claim — including any a dependency
 * adds in a patch bump. Two exact document names are allowed and everything
 * else 404s, so adding a third is a visible edit here.
 */

/** Better Auth's mount point — `src/routes/api/auth/$.ts`, and its base path. */
export const AUTH_BASE_PATH = "/api/auth";

/** The MCP protected resource `mcp()` binds issued tokens to (`src/routes/api/mcp.ts`). */
export const MCP_RESOURCE_PATH = "/api/mcp";

/** Where `mcp()` sends an unauthenticated authorize request (`src/routes/signin.tsx`). */
export const AUTH_SIGNIN_PATH = "/signin";

/** Where `mcp()` sends a request needing consent. Built in #843; declared here because the provider reads it at construction. */
export const AUTH_CONSENT_PATH = "/oauth/consent";

const AUTHORIZATION_SERVER_METADATA = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

/**
 * The requested root path → the path Better Auth answers it on.
 *
 * Built from the constants above rather than written out, so a change to the
 * auth mount point or the MCP resource path moves the aliases with it.
 */
const FORWARDS = new Map<string, string>([
	// RFC 8414. Neither root form is served as-is; both rewrite onto the base path.
	[
		AUTHORIZATION_SERVER_METADATA,
		`${AUTH_BASE_PATH}${AUTHORIZATION_SERVER_METADATA}`,
	],
	// The issuer-path-inserted alias RFC 8414 §3.1 prescribes for an issuer with
	// a path component. Clients that build it this way get the same document.
	[
		`${AUTHORIZATION_SERVER_METADATA}${AUTH_BASE_PATH}`,
		`${AUTH_BASE_PATH}${AUTHORIZATION_SERVER_METADATA}`,
	],
	// RFC 9728. Served at the root already — forwarded unchanged.
	[PROTECTED_RESOURCE_METADATA, PROTECTED_RESOURCE_METADATA],
	[
		`${PROTECTED_RESOURCE_METADATA}${MCP_RESOURCE_PATH}`,
		`${PROTECTED_RESOURCE_METADATA}${MCP_RESOURCE_PATH}`,
	],
]);

/**
 * The paths Better Auth's RATE LIMITER sees for the forwarded documents.
 *
 * `auth.handler` meters a request before it routes it — `onRequestRateLimit`
 * runs ahead of every plugin `onRequest` hook — so forwarding discovery into
 * the handler puts both documents behind this repo's global
 * `{ window: 60, max: 20 }`. Measured before this existed: the 21st discovery
 * request in a minute returned 429.
 *
 * That alone would be survivable. What is not: when Better Auth cannot resolve
 * a client IP (any `x-forwarded-for` with more than one hop, unless
 * `trustedProxies` is configured), it falls back to ONE SHARED BUCKET PER PATH
 * and logs a warning saying so. Behind a proxy that makes the limit global —
 * every claude.ai fetch sharing 20 requests a minute with every scanner that
 * finds the endpoint. A connector that discovers intermittently is worse than
 * one that never works, because it looks like a claude.ai bug.
 *
 * So the limiter is switched OFF for exactly these paths (`src/lib/auth.ts`
 * builds its `customRules` from this list). A finite limit would not help: with
 * one shared bucket, ANY ceiling is something a single caller can exhaust to
 * lock everyone else out. What makes that safe here is what these documents
 * are — public, unauthenticated, byte-identical per deploy, served with
 * `Cache-Control: public, max-age=15` by the provider itself, and reaching no
 * database. Exempting them also REMOVES a memory-growth vector rather than
 * adding one, since each metered path+IP mints an entry in an in-process Map.
 *
 * Derived from `FORWARDS` rather than written out, so widening the allowlist
 * cannot silently leave a document metered. The normalization mirrors
 * `normalizePathname`: the handler strips its own base path before matching.
 *
 * One consequence of matching the NORMALIZED path, measured rather than
 * assumed: each key also exempts its `/api/auth`-prefixed spelling. For the
 * authorization-server document that is the same document and is intended;
 * for the other two it means three URLs that 404 are now unmetered. Those
 * paths reach no database and build no document, and everything else stays
 * metered — `/sign-in/magic-link`, `get-session` and `jwks` were each still
 * refused at request 21 with this in place.
 */
export const DISCOVERY_RATE_LIMIT_PATHS: readonly string[] = Array.from(
	new Set(
		Array.from(FORWARDS.values(), (target) =>
			target.startsWith(`${AUTH_BASE_PATH}/`)
				? target.slice(AUTH_BASE_PATH.length)
				: target,
		),
	),
);

/** The only method either document answers. */
const ALLOWED_METHOD = "GET";

export type WellKnownForward =
	/** Rewrite the request onto `pathname` and hand it to `auth.handler`. */
	| { kind: "forward"; pathname: string }
	/** An allowlisted document, asked for with a method it does not answer. */
	| { kind: "method-not-allowed"; allow: string }
	/** Not one of the two documents. */
	| { kind: "not-found" };

/**
 * Decide what a `/.well-known/*` request gets, from its pathname and method alone.
 *
 * Matching is EXACT against the allowlist, which is what makes a traversal
 * attempt (`/.well-known/../api/auth/session`, encoded or not) a plain 404
 * rather than something this function has to reason about: a path that is not
 * one of the four strings is not forwarded, whatever it contains.
 *
 * The method check runs only after the path is known to be allowlisted, so an
 * unknown path answers 404 for every method rather than leaking which paths
 * exist by answering 405 for some of them.
 */
export function resolveWellKnownForward(
	pathname: string,
	method: string,
): WellKnownForward {
	const target = FORWARDS.get(pathname);
	if (!target) return { kind: "not-found" };
	if (method.toUpperCase() !== ALLOWED_METHOD) {
		return { kind: "method-not-allowed", allow: ALLOWED_METHOD };
	}
	return { kind: "forward", pathname: target };
}

/**
 * Answer a `/.well-known/*` request by forwarding it to Better Auth.
 *
 * `handler` is a parameter rather than an import so this module never pulls
 * `#/lib/auth` — and through it `pg` — into anything that only needs the pure
 * resolver above. The route passes the real `auth.handler`, and
 * `well-known-discovery.integration.test.ts` holds that wiring, because a
 * `createFileRoute` handler body cannot be reached from a test (#544).
 *
 * Method, headers and body are preserved across the rewrite; only the pathname
 * changes. The query string is carried too — nothing reads one today, but
 * dropping it would be a silent difference from what the client sent.
 */
export async function serveWellKnownDiscovery(
	request: Request,
	handler: (request: Request) => Promise<Response>,
): Promise<Response> {
	const url = new URL(request.url);
	const resolved = resolveWellKnownForward(url.pathname, request.method);

	if (resolved.kind === "not-found") {
		return new Response("Not Found", { status: 404 });
	}
	if (resolved.kind === "method-not-allowed") {
		return new Response(null, {
			status: 405,
			headers: { Allow: resolved.allow },
		});
	}

	url.pathname = resolved.pathname;
	return handler(new Request(url, request));
}
