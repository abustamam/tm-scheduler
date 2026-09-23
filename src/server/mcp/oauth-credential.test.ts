/**
 * The credential-kind decision and the pure half of the OAuth path (#843), with
 * no database. The verification itself — audience, issuer, expiry, a real
 * grant through Better Auth — is DB-backed and lives in
 * `mcp-route.integration.test.ts`, because a verifier driven by stub keys
 * proves only that the stub agrees with itself.
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const resolveActiveApiToken = vi.fn();
vi.mock("#/db", () => ({ db: {} }));
vi.mock("#/server/api-tokens-logic", () => ({
	API_TOKEN_PREFIX: "tmk_",
	resolveActiveApiToken,
	touchApiToken: vi.fn(),
}));

const { isPersonalToken, McpUnauthorizedError, resolveCredential } =
	await import("./authz-logic");
const { bearerChallenge, grantFromClaims, protectedResourceMetadataUrl } =
	await import("./oauth-claims");
type McpCredential = import("./authz-logic").McpCredential;

beforeEach(() => {
	resolveActiveApiToken.mockReset();
});

describe("prefix discrimination", () => {
	it("routes a tmk_ token to api_tokens and marks it for the last_used_at stamp", async () => {
		resolveActiveApiToken.mockResolvedValue({ id: "tok-1", userId: "u-1" });
		const resolved = await resolveCredential({ rawToken: "tmk_abc" });
		expect(resolveActiveApiToken).toHaveBeenCalledWith("tmk_abc");
		expect(resolved).toEqual({
			userId: "u-1",
			credential: { kind: "personal", tokenId: "tok-1" },
			touch: "tok-1",
		});
	});

	it("takes a verified OAuth grant's user without touching api_tokens", async () => {
		const resolved = await resolveCredential({
			oauthGrant: { userId: "u-2", clientId: "client-9", tokenId: "jti-3" },
		});
		expect(resolveActiveApiToken).not.toHaveBeenCalled();
		// No `touch`: `touchApiToken` writes an `api_tokens` row, and there is
		// none for an OAuth token. This is the only thing `authenticateToken`
		// reads to decide whether to stamp.
		expect(resolved).toEqual({
			userId: "u-2",
			credential: { kind: "oauth", tokenId: "jti-3", clientId: "client-9" },
		});
	});

	it("refuses an absent or EMPTY credential as missing", async () => {
		for (const rawToken of [null, ""]) {
			await expect(resolveCredential({ rawToken })).rejects.toThrow(
				"Missing bearer token.",
			);
		}
		expect(resolveActiveApiToken).not.toHaveBeenCalled();
	});

	it("refuses a non-tmk_ value on the personal path without a lookup", async () => {
		// `handle-request` sends only `tmk_` values here; this is the belt to that
		// brace, and it must fail ONCE — not hash and query a value `api_tokens`
		// cannot hold.
		await expect(
			resolveCredential({ rawToken: "eyJhbGciOi.not.personal" }),
		).rejects.toBeInstanceOf(McpUnauthorizedError);
		expect(resolveActiveApiToken).not.toHaveBeenCalled();
	});

	it("refuses a tmk_-prefixed string that is not a real token", async () => {
		resolveActiveApiToken.mockResolvedValue(null);
		await expect(
			resolveCredential({ rawToken: "tmk_not_a_real_token" }),
		).rejects.toBeInstanceOf(McpUnauthorizedError);
		expect(resolveActiveApiToken).toHaveBeenCalledOnce();
	});

	it("reads the prefix, and only the prefix", () => {
		expect(isPersonalToken("tmk_x")).toBe(true);
		expect(isPersonalToken("tmk_")).toBe(true);
		// Case matters: `generateRawApiToken` writes it lower-case, and an
		// upper-case look-alike is not one of ours.
		expect(isPersonalToken("TMK_x")).toBe(false);
		expect(isPersonalToken("x_tmk_")).toBe(false);
		expect(isPersonalToken("gup_x")).toBe(false);
		expect(isPersonalToken("")).toBe(false);
	});
});

describe("McpCredential", () => {
	it("narrows on kind: only the oauth arm carries a clientId", () => {
		const describe = (c: McpCredential): string => {
			switch (c.kind) {
				case "personal":
					// @ts-expect-error — a personal token has no client.
					return c.clientId;
				case "oauth":
					return c.clientId;
				default: {
					const unreachable: never = c;
					return unreachable;
				}
			}
		};
		expectTypeOf<Extract<McpCredential, { kind: "oauth" }>>().toHaveProperty(
			"clientId",
		);
		expect(describe({ kind: "oauth", tokenId: "j", clientId: "claude" })).toBe(
			"claude",
		);
	});
});

describe("grantFromClaims", () => {
	const claims = {
		sub: "user-1",
		client_id: "client-1",
		azp: "client-1",
		jti: "jti-1",
	};

	it("reads the user, client and token id off verified claims", () => {
		expect(grantFromClaims(claims)).toEqual({
			userId: "user-1",
			clientId: "client-1",
			tokenId: "jti-1",
		});
	});

	it("falls back to azp when client_id is absent", () => {
		const { client_id: _omit, ...rest } = claims;
		expect(grantFromClaims(rest)?.clientId).toBe("client-1");
	});

	it("refuses a token issued to the client itself (client credentials)", () => {
		// `sub` is the client's id on a client-credentials token: there is no
		// person to credit a write to.
		expect(grantFromClaims({ ...claims, sub: "client-1" })).toBeNull();
	});

	it("refuses a missing or non-string sub, client or jti", () => {
		for (const bad of [
			{ ...claims, sub: undefined },
			{ ...claims, sub: "" },
			{ ...claims, sub: 42 },
			{ ...claims, client_id: undefined, azp: undefined },
			{ ...claims, jti: undefined },
		]) {
			expect(grantFromClaims(bad), JSON.stringify(bad)).toBeNull();
		}
	});
});

describe("the challenge", () => {
	it("names the RFC 9728 document for /api/mcp at the origin root", () => {
		// `setup-env.ts` sets BETTER_AUTH_URL to http://localhost:3000.
		expect(protectedResourceMetadataUrl()).toBe(
			"http://localhost:3000/.well-known/oauth-protected-resource/api/mcp",
		);
		expect(bearerChallenge()).toBe(
			'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"',
		);
	});

	it("inserts the well-known name between origin and path, dropping a trailing slash", () => {
		expect(protectedResourceMetadataUrl("https://gavelup.app/api/mcp/")).toBe(
			"https://gavelup.app/.well-known/oauth-protected-resource/api/mcp",
		);
	});
});
