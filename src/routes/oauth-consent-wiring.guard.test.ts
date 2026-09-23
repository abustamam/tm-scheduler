/**
 * The consent and sign-in pages are wired to the provider the way the
 * integration suite proved works (#843).
 *
 * `oauth-consent.integration.test.ts` drives the URLs these pages BUILD
 * through the real `auth.handler`; `oauth.consent.test.tsx` renders the page.
 * Neither can see a page that quietly stopped building them that way — a
 * `validateSearch` that starts normalising, a POST body rebuilt from the
 * router's parsed search, a magic link sent without the escape — because each
 * of those still renders and still passes the pure tests. Every one of them
 * broke the flow in a real browser while it was being built, so each is
 * pinned here. Comment-blind (`readSource`): these are "must be present"
 * assertions, and a comment naming the call would otherwise satisfy them.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTH_CONSENT_PATH, AUTH_SIGNIN_PATH } from "#/lib/well-known-forward";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const consent = readSource(join(HERE, "oauth.consent.tsx"));
const signin = readSource(join(HERE, "signin.tsx"));
const authConfig = readSource(resolve(HERE, "../lib/auth.ts"));

describe("/oauth/consent is the page mcp() sends consent to", () => {
	it("registers the path auth.ts hands the provider", () => {
		expect(AUTH_CONSENT_PATH).toBe("/oauth/consent");
		expect(consent).toContain(`createFileRoute("${AUTH_CONSENT_PATH}")`);
		expect(authConfig).toContain("consentPage: AUTH_CONSENT_PATH");
		expect(authConfig).toContain("loginPage: AUTH_SIGNIN_PATH");
		expect(signin).toContain(`createFileRoute("${AUTH_SIGNIN_PATH}")`);
	});

	it("passes its search through untouched, so the server never 307s it", () => {
		// A search that changes makes TanStack redirect to a re-serialised URL,
		// and the provider's signature fails on it.
		expect(consent).toMatch(
			/validateSearch:\s*\(search: Record<string, unknown>\): ConsentSearch =>\s*search,/,
		);
	});

	it("posts the decision to Better Auth with the RAW query off window.location", () => {
		expect(consent).toContain("`${AUTH_BASE_PATH}/oauth2/consent`");
		expect(consent).toContain(
			"oauth_query: oauthQueryFromLocation(window.location.search)",
		);
		expect(consent).toMatch(/fetch\(CONSENT_ENDPOINT,/);
	});

	it("sends the displayed account with the decision, and auth.ts refuses a mismatch", () => {
		// The page half and the server half of one rule: either alone is not a
		// binding. The integration suite proves the refusal against the real
		// provider; this pins that both halves are still wired.
		expect(consent).toContain("[CONSENT_ACCOUNT_FIELD]: expectedUserId");
		expect(consent).toContain("decide(true, userId)");
		expect(authConfig).toMatch(
			/if \(ctx\.path !== "\/oauth2\/consent"\) return;[\s\S]*?consentAccountMismatch\(ctx\.body, session\??\.user\.id\)[\s\S]*?throw new APIError/,
		);
	});

	it("is served with anti-framing headers", () => {
		expect(consent).toContain('"X-Frame-Options": "DENY"');
		expect(consent).toContain(
			'"Content-Security-Policy": "frame-ancestors \'none\'"',
		);
	});

	it("navigates through the testable seam, not window.location directly", () => {
		expect(consent).toContain("assignLocation(next)");
		expect(consent).not.toMatch(/window\.location\.(assign|replace|reload)\(/);
	});

	it("takes the client's name from the server lookup, never from its URL", () => {
		expect(consent).toContain("getOAuthConsentClient(");
		expect(consent).toContain("lookup.client?.name");
		// The spoofing surface: a name read straight off the query.
		expect(consent).not.toMatch(/search\.client_name|client_name\b/);
	});

	it("bounces a signed-out visitor to /signin with the authorize continuation", () => {
		expect(consent).toContain(
			"oauthAuthorizeContinuation(window.location.search)",
		);
		expect(consent).toMatch(/signInHref\(\s*continuation \?\?/);
	});
});

describe("/signin resumes an OAuth flow", () => {
	it("adds nothing to a provider prompt's search", () => {
		expect(signin).toMatch(
			/isSignedOAuthSearch\(search\)\s*\?\s*\{\}\s*:\s*\{ redirect: safeRedirect\(search\.redirect\) \}/,
		);
	});

	it("mails a link to the authorize continuation built from the raw URL", () => {
		expect(signin).toContain(
			"oauthAuthorizeContinuation(window.location.search)",
		);
	});

	it("escapes the callback for Better Auth's double decode", () => {
		expect(signin).toContain("callbackURL: magicLinkCallbackURL(redirect)");
	});
});
