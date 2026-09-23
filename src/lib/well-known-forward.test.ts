/**
 * The `/.well-known/*` allowlist and URL rewrite (#842 / ADR-0027).
 *
 * The route is a splat: it is handed every `.well-known` path under the origin
 * and decides which two it answers. That decision is the whole security
 * surface of the route — hand a path through and `auth.handler` answers it,
 * whatever it is — so it lives here as a pure function with no `auth` import,
 * and the integration suite beside it checks the documents that come back.
 */
import { describe, expect, it } from "vitest";
import {
	AUTH_BASE_PATH,
	DISCOVERY_RATE_LIMIT_PATHS,
	MCP_RESOURCE_PATH,
	resolveWellKnownForward,
	serveWellKnownDiscovery,
} from "#/lib/well-known-forward";

const AUTH_SERVER = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

describe("resolveWellKnownForward", () => {
	it("rewrites the authorization-server document onto the auth base path", () => {
		// The BARE root path is the one no Better Auth mechanism answers: the
		// provider matches `<issuerPath>/.well-known/…` and
		// `/.well-known/…<issuerPath>`, and the issuer here has the path
		// `/api/auth`. Passing this through unchanged is the bug this rewrite
		// exists to prevent, and it would surface as a 404 on the one URL an
		// RFC 8414 client asks for first.
		expect(resolveWellKnownForward(AUTH_SERVER, "GET")).toEqual({
			kind: "forward",
			pathname: `${AUTH_BASE_PATH}${AUTH_SERVER}`,
		});
	});

	it("answers the issuer-path-inserted alias with the same document", () => {
		// RFC 8414 §3.1: an issuer with a path component is discovered at
		// `/.well-known/oauth-authorization-server` + that path. A client that
		// builds the URL this way must not get a different document from one
		// that asks for the bare path.
		expect(
			resolveWellKnownForward(`${AUTH_SERVER}${AUTH_BASE_PATH}`, "GET"),
		).toEqual({ kind: "forward", pathname: `${AUTH_BASE_PATH}${AUTH_SERVER}` });
	});

	it("forwards the protected-resource document unchanged", () => {
		// `@better-auth/mcp` serves RFC 9728 metadata at the ROOT path already,
		// so rewriting this one onto the base path would 404 it. The two
		// documents are deliberately not treated alike.
		expect(resolveWellKnownForward(PROTECTED_RESOURCE, "GET")).toEqual({
			kind: "forward",
			pathname: PROTECTED_RESOURCE,
		});
		expect(
			resolveWellKnownForward(
				`${PROTECTED_RESOURCE}${MCP_RESOURCE_PATH}`,
				"GET",
			),
		).toEqual({
			kind: "forward",
			pathname: `${PROTECTED_RESOURCE}${MCP_RESOURCE_PATH}`,
		});
	});

	it("404s an unknown document rather than forwarding it", () => {
		expect(
			resolveWellKnownForward("/.well-known/anything-else", "GET"),
		).toEqual({ kind: "not-found" });
		// `openid-configuration` is the one that would be easy to wave through:
		// this provider really does serve it, and a client really does ask for
		// it. It stays out until something needs it, because every path added
		// here is a path this route becomes responsible for.
		expect(
			resolveWellKnownForward("/.well-known/openid-configuration", "GET"),
		).toEqual({ kind: "not-found" });
	});

	it("404s a traversal attempt instead of reasoning about it", () => {
		// Matching is exact against four strings, so none of these is a special
		// case the function has to recognise — which is the point. A rewrite
		// built by concatenation would have to defend against each one.
		for (const pathname of [
			"/.well-known/../api/auth/get-session",
			"/.well-known/%2e%2e/api/auth/get-session",
			`${AUTH_SERVER}/../../api/auth/oauth2/register`,
			`${PROTECTED_RESOURCE}/`,
		]) {
			expect(resolveWellKnownForward(pathname, "GET")).toEqual({
				kind: "not-found",
			});
		}
	});

	it("405s a write to an allowlisted document, and still 404s an unknown one", () => {
		expect(resolveWellKnownForward(AUTH_SERVER, "POST")).toEqual({
			kind: "method-not-allowed",
			allow: "GET",
		});
		// The method check runs only AFTER the path is known to be allowlisted.
		// Answering 405 on an unknown path would say which paths exist.
		expect(
			resolveWellKnownForward("/.well-known/anything-else", "POST"),
		).toEqual({ kind: "not-found" });
	});
});

describe("DISCOVERY_RATE_LIMIT_PATHS", () => {
	it("names every path the handler will meter, with its base path stripped", () => {
		// Stated as absolute literals, NOT rebuilt from the constants under test:
		// a list derived from `FORWARDS` and then compared against `FORWARDS`
		// agrees with itself no matter what either one says. These are the exact
		// strings Better Auth's `normalizePathname` produces for the forwarded
		// requests, which is what its `customRules` keys are matched against.
		expect([...DISCOVERY_RATE_LIMIT_PATHS].sort()).toEqual([
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/api/mcp",
		]);
	});

	it("exempts one path per distinct document, with no duplicates", () => {
		// The drift this closes: widening the allowlist without exempting the new
		// document leaves it metered, and a metered document is one a single
		// caller can lock claude.ai out of. A first draft of this test rebuilt the
		// expectation with the SAME ternary the implementation uses, so it agreed
		// with the code for any value — the trap CLAUDE.md names. The literal list
		// above is the real assertion; this one only pins that the derivation
		// de-duplicates, since the two authorization-server spellings share a
		// target and must not produce two identical keys.
		expect(DISCOVERY_RATE_LIMIT_PATHS).toHaveLength(
			new Set(DISCOVERY_RATE_LIMIT_PATHS).size,
		);
		expect(DISCOVERY_RATE_LIMIT_PATHS).toHaveLength(3);
	});
});

describe("serveWellKnownDiscovery", () => {
	it("rewrites only the pathname, preserving origin, query, method and headers", async () => {
		let seen: Request | undefined;
		await serveWellKnownDiscovery(
			new Request(`https://gavelup.app${AUTH_SERVER}?probe=1`, {
				headers: { "x-probe": "kept" },
			}),
			async (request) => {
				seen = request;
				return new Response("ok");
			},
		);
		const url = new URL(seen?.url ?? "");
		expect(url.origin).toBe("https://gavelup.app");
		expect(url.pathname).toBe(`${AUTH_BASE_PATH}${AUTH_SERVER}`);
		expect(url.search).toBe("?probe=1");
		expect(seen?.method).toBe("GET");
		expect(seen?.headers.get("x-probe")).toBe("kept");
	});

	it("never calls the handler for a path outside the allowlist", async () => {
		// The failure this guards is the one a splat route invites: a
		// pass-through that hands `auth.handler` arbitrary origin-root paths.
		let called = false;
		const response = await serveWellKnownDiscovery(
			new Request("https://gavelup.app/.well-known/openid-configuration"),
			async () => {
				called = true;
				return new Response("ok");
			},
		);
		expect(called).toBe(false);
		expect(response.status).toBe(404);
	});

	it("answers 405 with an Allow header, without calling the handler", async () => {
		let called = false;
		const response = await serveWellKnownDiscovery(
			new Request(`https://gavelup.app${AUTH_SERVER}`, { method: "POST" }),
			async () => {
				called = true;
				return new Response("ok");
			},
		);
		expect(called).toBe(false);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});
});
