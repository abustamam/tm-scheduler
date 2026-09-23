/**
 * Turning the provider's signed prompts back into something `/signin` and
 * `/oauth/consent` can act on (#843). The shapes here were captured from a
 * real `@better-auth/oauth-provider@1.7.5` redirect, not written from docs.
 */
import { describe, expect, it } from "vitest";
import { magicLinkCallbackURL } from "./magic-link-callback";
import {
	isOAuthAuthorizeTarget,
	isSignedOAuthQuery,
	oauthAuthorizeContinuation,
	oauthQueryFromLocation,
	parseConsentQuery,
} from "./oauth-continuation";
import { safeRedirect } from "./write-proof";

/** The authorize request claude.ai starts with, as it would encode it. */
const AUTHORIZE =
	"response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
	"&state=aB-_c%2Bd%2Fe%3D%26f&client_id=kOjdqUmnrmVBfTCNFXYyRkbaacVBunXn" +
	"&code_challenge=TeL2kvahUkECukK-NLFnpwXqp8sYYuobfmK9MfbAiak&code_challenge_method=S256" +
	"&resource=https%3A%2F%2Fgavelup.app%2Fapi%2Fmcp&scope=openid+profile+email+offline_access";

/** …and what the provider appends to sign it. */
const SIGNED =
	`${AUTHORIZE}&exp=1790170838&ba_iat=1790170238241` +
	"&ba_param=ba_iat&ba_param=ba_param&ba_param=client_id&ba_param=code_challenge" +
	"&ba_param=code_challenge_method&ba_param=exp&ba_param=redirect_uri&ba_param=resource" +
	"&ba_param=response_type&ba_param=scope&ba_param=state" +
	"&sig=rDxYBn4cKSX2VvN2NN5zDx5KxbWP5%2FLfNJdEpDtOCnY%3D";

describe("oauthAuthorizeContinuation", () => {
	it("replays the original authorize request with the signing params removed", () => {
		const out = oauthAuthorizeContinuation(`?${SIGNED}`);
		expect(out).not.toBeNull();
		const url = new URL(out as string, "https://gavelup.app");
		expect(url.pathname).toBe("/api/auth/oauth2/authorize");
		for (const gone of ["sig", "exp", "ba_iat", "ba_param", "ba_pl"]) {
			expect(url.searchParams.has(gone), gone).toBe(false);
		}
		// Every original value survives decoding intact — including a `state`
		// holding `+`, `/`, `=` and `&`, which is where a lossy round trip
		// would show first.
		const original = new URLSearchParams(AUTHORIZE);
		expect([...url.searchParams.entries()]).toEqual([...original.entries()]);
		expect(url.searchParams.get("state")).toBe("aB-_c+d/e=&f");
	});

	it("drops /signin's own redirect parameter", () => {
		const out = oauthAuthorizeContinuation(`?${SIGNED}&redirect=%2Fofficers`);
		expect(out).not.toContain("redirect=%2Fofficers");
	});

	it("is null for an ordinary sign-in visit", () => {
		expect(oauthAuthorizeContinuation("?redirect=%2Fme")).toBeNull();
		expect(oauthAuthorizeContinuation("")).toBeNull();
		// A signature with no client is not a prompt the provider sends.
		expect(oauthAuthorizeContinuation("?sig=abc")).toBeNull();
	});

	it("survives /signin's safeRedirect — the redirect allowlist needs no change", () => {
		// Pinned so that a future tightening of `REDIRECT_CHARS` or
		// `MAX_REDIRECT_LENGTH` fails HERE, loudly, rather than silently sending
		// every OAuth sign-in to /officers and dead-ending the connector.
		const continuation = oauthAuthorizeContinuation(`?${SIGNED}`) as string;
		expect(safeRedirect(continuation)).toBe(continuation);
		// …and so does the consent URL the signed-out bounce used to carry.
		const consent = `/oauth/consent?${SIGNED}`;
		expect(safeRedirect(consent)).toBe(consent);
		expect(isOAuthAuthorizeTarget(continuation)).toBe(true);
	});

	it("an escaped continuation decodes back to itself exactly once more", () => {
		// What Better Auth's magic-link verify does to a callback: decode it a
		// second time (`magic-link-callback.ts`). Unescaped, that turns the
		// `state`'s `%26` into a parameter separator.
		const continuation = oauthAuthorizeContinuation(`?${SIGNED}`) as string;
		expect(decodeURIComponent(magicLinkCallbackURL(continuation))).toBe(
			continuation,
		);
		expect(decodeURIComponent(continuation)).not.toBe(continuation);
	});
});

describe("the other helpers", () => {
	it("isSignedOAuthQuery needs both a signature and a client", () => {
		expect(isSignedOAuthQuery(`?${SIGNED}`)).toBe(true);
		expect(isSignedOAuthQuery(SIGNED)).toBe(true);
		expect(isSignedOAuthQuery(`?${AUTHORIZE}`)).toBe(false);
		expect(isSignedOAuthQuery("?sig=x")).toBe(false);
	});

	it("isOAuthAuthorizeTarget matches the authorize path only", () => {
		expect(isOAuthAuthorizeTarget("/api/auth/oauth2/authorize?x=1")).toBe(true);
		expect(isOAuthAuthorizeTarget("/api/auth/oauth2/authorizeX?x=1")).toBe(
			false,
		);
		expect(isOAuthAuthorizeTarget("/officers")).toBe(false);
		expect(isOAuthAuthorizeTarget(undefined)).toBe(false);
	});

	it("oauthQueryFromLocation strips only the leading ?", () => {
		expect(oauthQueryFromLocation(`?${SIGNED}`)).toBe(SIGNED);
		expect(oauthQueryFromLocation(SIGNED)).toBe(SIGNED);
	});

	it("parseConsentQuery accepts a signed prompt and refuses what is not one", () => {
		expect(
			parseConsentQuery({ client_id: "c1", sig: "s", scope: "openid profile" }),
		).toEqual({ ok: true, clientId: "c1", scopes: ["openid", "profile"] });
		expect(parseConsentQuery({ client_id: "c1", sig: "s" })).toEqual({
			ok: true,
			clientId: "c1",
			scopes: [],
		});
		for (const bad of [
			{},
			{ client_id: "c1" },
			{ sig: "s" },
			{ client_id: "", sig: "s" },
			// The router parses an all-digit value as a number; not a client id.
			{ client_id: 12345, sig: "s" },
			{ client_id: "c1", sig: ["a", "b"] },
		]) {
			expect(parseConsentQuery(bad), JSON.stringify(bad)).toEqual({
				ok: false,
			});
		}
	});
});
