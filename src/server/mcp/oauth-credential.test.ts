/**
 * The credential-kind decision and the pure half of the OAuth path (#843), with
 * no database. The verification itself — audience, issuer, expiry, a real
 * grant through Better Auth — is DB-backed and lives in
 * `mcp-route.integration.test.ts`, because a verifier driven by stub keys
 * proves only that the stub agrees with itself.
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const { resolveActiveApiToken, touchApiToken, dbResults } = vi.hoisted(() => ({
	resolveActiveApiToken: vi.fn(),
	touchApiToken: vi.fn(),
	/** What each successive awaited query resolves to, in order. */
	dbResults: [] as unknown[][],
}));

/**
 * A query builder that accepts any chain and resolves, when awaited, to the
 * next queued result. `authenticateToken` runs two queries — the owner, then
 * the admin clubs — and neither's SQL is what this suite is about.
 */
function chain(): unknown {
	const target = () => {};
	return new Proxy(target, {
		get: (_t, prop) =>
			prop === "then"
				? (resolve: (v: unknown) => void) => resolve(dbResults.shift() ?? [])
				: () => chain(),
		apply: () => chain(),
	});
}

vi.mock("#/db", () => ({ db: { select: () => chain() } }));
vi.mock("#/server/api-tokens-logic", () => ({
	API_TOKEN_PREFIX: "tmk_",
	resolveActiveApiToken,
	touchApiToken,
}));

const {
	authenticateToken,
	isPersonalToken,
	McpUnauthorizedError,
	resolveCredential,
} = await import("./authz-logic");
const {
	accessTokenFrom,
	bearerChallenge,
	createKidGate,
	grantFromClaims,
	jwsKey,
	protectedResourceMetadataUrl,
	unauthorizedResponse,
} = await import("./oauth-claims");
type McpCredential = import("./authz-logic").McpCredential;

beforeEach(() => {
	resolveActiveApiToken.mockReset();
	touchApiToken.mockReset().mockResolvedValue(undefined);
	dbResults.length = 0;
});

describe("prefix discrimination", () => {
	it("routes a tmk_ token to api_tokens and marks it for the last_used_at stamp", async () => {
		resolveActiveApiToken.mockResolvedValue({ id: "tok-1", userId: "u-1" });
		const resolved = await resolveCredential({ rawToken: "tmk_abc" });
		expect(resolveActiveApiToken).toHaveBeenCalledWith("tmk_abc");
		expect(resolved).toEqual({
			userId: "u-1",
			credential: { kind: "personal", tokenId: "tok-1" },
		});
	});

	it("takes a verified OAuth grant's user without looking at api_tokens", async () => {
		const resolved = await resolveCredential({
			oauthGrant: { userId: "u-2", clientId: "client-9", tokenId: "jti-3" },
		});
		expect(resolveActiveApiToken).not.toHaveBeenCalled();
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

describe("authenticateToken stamps last_used_at for personal tokens only", () => {
	const owner = { id: "u-1", name: "Owner", email: "o@example.com" };

	it("stamps the personal token it resolved", async () => {
		resolveActiveApiToken.mockResolvedValue({ id: "tok-1", userId: "u-1" });
		dbResults.push([owner], []);
		await authenticateToken({ rawToken: "tmk_abc" });
		expect(touchApiToken).toHaveBeenCalledExactlyOnceWith("tok-1");
	});

	it("never stamps for an OAuth grant", async () => {
		// Not caught by the DB-backed suite alone: `touchApiToken(jti)` would
		// match no row there (a jti is not an api_tokens id) and its error is
		// swallowed by design, so a wrong stamp would leave nothing to see.
		dbResults.push([owner], []);
		await authenticateToken({
			oauthGrant: { userId: "u-1", clientId: "c", tokenId: "jti-1" },
		});
		expect(touchApiToken).not.toHaveBeenCalled();
	});

	it("fails closed for a verified token whose user is gone", async () => {
		dbResults.push([], []);
		await expect(
			authenticateToken({
				oauthGrant: { userId: "gone", clientId: "c", tokenId: "jti-1" },
			}),
		).rejects.toBeInstanceOf(McpUnauthorizedError);
	});
});

describe("the challenge body", () => {
	it("is the JSON-RPC envelope Better Auth sends for its own refusals", async () => {
		const res = unauthorizedResponse("nope");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			jsonrpc: "2.0",
			error: { code: -32000, message: "nope" },
			id: null,
		});
	});
});

/** A syntactically valid, unsigned JWS with this protected header. */
const jws = (header: Record<string, unknown>) =>
	`${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.sig`;

describe("accessTokenFrom and jwsKey", () => {
	it("reads Bearer and DPoP tokens and nothing else", () => {
		expect(accessTokenFrom("Bearer abc")).toBe("abc");
		expect(accessTokenFrom("dpop abc")).toBe("abc");
		expect(accessTokenFrom("Basic abc")).toBeNull();
		expect(accessTokenFrom("Bearer a b")).toBeNull();
		expect(accessTokenFrom(null)).toBeNull();
	});

	it("reads a kid, and says when there is none or it is not a JWS", () => {
		expect(jwsKey(jws({ alg: "EdDSA", kid: "k1" }))).toEqual({
			kind: "kid",
			kid: "k1",
		});
		expect(jwsKey(jws({ alg: "EdDSA" }))).toEqual({ kind: "no-kid" });
		expect(jwsKey(jws({ alg: "EdDSA", kid: 7 }))).toEqual({
			kind: "malformed",
		});
		expect(jwsKey("not-a-jwt")).toEqual({ kind: "malformed" });
		expect(jwsKey("a.b")).toEqual({ kind: "malformed" });
		expect(jwsKey("%%%.e30.x")).toEqual({ kind: "malformed" });
	});

	it("reports a kid spelled like a parser outcome as a kid, not as that outcome", () => {
		// The sentinel collision: these used to be the parser's own answers.
		for (const kid of ["absent", "malformed", "no-kid"]) {
			expect(jwsKey(jws({ kid }))).toEqual({ kind: "kid", kid });
		}
	});
});

describe("createKidGate", () => {
	function gate(kids: string[][]) {
		let t = 0;
		const loads = vi.fn(async () => kids.shift() ?? []);
		const g = createKidGate(loads, {
			ttlMs: 300_000,
			missCooldownMs: 30_000,
			now: () => t,
		});
		return { g, loads, advance: (ms: number) => (t += ms) };
	}

	it("admits a known kid and refuses a flood of unknown ones with ONE reload", async () => {
		const { g, loads } = gate([["real"]]);
		expect(await g.admits(jws({ kid: "real" }))).toBe(true);
		for (let i = 0; i < 50; i++) {
			expect(await g.admits(jws({ kid: `forged-${i}` }))).toBe(false);
		}
		// The whole point: fifty forged kids cost one load, not fifty fetches.
		expect(loads).toHaveBeenCalledTimes(1);
	});

	it("picks up a rotated key once the miss cooldown has passed", async () => {
		const { g, loads, advance } = gate([["old"], ["old", "new"]]);
		expect(await g.admits(jws({ kid: "old" }))).toBe(true);
		expect(await g.admits(jws({ kid: "new" }))).toBe(false);
		advance(30_000);
		expect(await g.admits(jws({ kid: "new" }))).toBe(true);
		expect(loads).toHaveBeenCalledTimes(2);
	});

	it("reloads when the key set has gone stale", async () => {
		const { g, loads, advance } = gate([["a"], ["b"]]);
		expect(await g.admits(jws({ kid: "a" }))).toBe(true);
		advance(300_000);
		expect(await g.admits(jws({ kid: "a" }))).toBe(false);
		expect(loads).toHaveBeenCalledTimes(2);
	});

	it("shares one load between concurrent first requests", async () => {
		const { g, loads } = gate([["k"]]);
		const results = await Promise.all(
			Array.from({ length: 10 }, () => g.admits(jws({ kid: "k" }))),
		);
		expect(results.every(Boolean)).toBe(true);
		expect(loads).toHaveBeenCalledTimes(1);
	});

	it("leaves a well-formed token with no kid to the verifier", async () => {
		const { g, loads } = gate([]);
		expect(await g.admits(jws({ alg: "EdDSA" }))).toBe(true);
		expect(loads).not.toHaveBeenCalled();
	});

	it("refuses a token that is not a well-formed JWS, without a load", async () => {
		const { g, loads } = gate([]);
		expect(await g.admits("opaque-token")).toBe(false);
		expect(await g.admits(jws({ kid: 7 }))).toBe(false);
		expect(loads).not.toHaveBeenCalled();
	});

	it("gates a kid literally named like a parser outcome as an unknown key", async () => {
		const { g, loads } = gate([["real"]]);
		for (let i = 0; i < 20; i++) {
			expect(await g.admits(jws({ kid: "absent" }))).toBe(false);
			expect(await g.admits(jws({ kid: "malformed" }))).toBe(false);
		}
		expect(loads).toHaveBeenCalledTimes(1);
	});

	// The PRODUCTION defaults, with only the clock injected. Every case above
	// passes its own timings, so without these a default of 0 — which reopens
	// the junk-kid flood — or of an hour — which strands a rotated key — would
	// leave the suite green. Bounded by absolute numbers chosen here, never by
	// the constants under test (CODING_STANDARDS.md, "Test coverage").
	describe("with its production defaults", () => {
		function defaultGate(kids: string[][]) {
			let t = 0;
			const loads = vi.fn(async () => kids.shift() ?? []);
			const g = createKidGate(loads, { now: () => t });
			return { g, loads, advance: (ms: number) => (t += ms) };
		}

		it("costs at most one load for a flood lasting five seconds", async () => {
			const { g, loads, advance } = defaultGate([["real"]]);
			await g.admits(jws({ kid: "real" }));
			for (let i = 0; i < 50; i++) {
				advance(100);
				await g.admits(jws({ kid: `forged-${i}` }));
			}
			expect(loads).toHaveBeenCalledTimes(1);
		});

		it("admits a rotated key within a minute", async () => {
			const { g, advance } = defaultGate([["old"], ["old", "new"]]);
			await g.admits(jws({ kid: "old" }));
			expect(await g.admits(jws({ kid: "new" }))).toBe(false);
			advance(60_000);
			expect(await g.admits(jws({ kid: "new" }))).toBe(true);
		});

		it("re-reads a stale key set within ten minutes, and not on every request", async () => {
			const { g, loads, advance } = defaultGate([["a"], ["b"]]);
			await g.admits(jws({ kid: "a" }));
			advance(1_000);
			await g.admits(jws({ kid: "a" }));
			expect(loads).toHaveBeenCalledTimes(1);
			advance(10 * 60 * 1000);
			expect(await g.admits(jws({ kid: "a" }))).toBe(false);
			expect(loads).toHaveBeenCalledTimes(2);
		});
	});

	it("throws, rather than refusing, when the key set cannot be read", async () => {
		const g = createKidGate(async () => {
			throw new Error("db down");
		});
		await expect(g.admits(jws({ kid: "k" }))).rejects.toThrow("db down");
	});
});
