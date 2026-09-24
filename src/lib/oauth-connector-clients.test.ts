// The CIMD pre-fetch gate (#852). The end-to-end half — that a refused id is
// never fetched and writes no client — is in `oauth-consent.integration.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CIMD_ALLOWED_CLIENT_IDS,
	isCimdClientIdAllowed,
	unlistedCimdClientId,
} from "./oauth-connector-clients";

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isCimdClientIdAllowed", () => {
	it("admits hosted Claude's document, and only it, without logging", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		expect([...CIMD_ALLOWED_CLIENT_IDS]).toEqual([CLAUDE]);
		expect(isCimdClientIdAllowed(CLAUDE)).toBe(true);
		expect(info).not.toHaveBeenCalled();
	});

	it.each([
		[
			"Claude Code's document",
			"https://claude.ai/oauth/claude-code-client-metadata",
		],
		["a longer path on the same URL", `${CLAUDE}/extra`],
		["a query on the same URL", `${CLAUDE}?x=1`],
		["another origin", "https://evil.example/client"],
	])("refuses %s — an exact match, not a prefix", (_label, url) => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		expect(isCimdClientIdAllowed(url)).toBe(false);
	});

	it("logs a refusal once, JSON-quoted and truncated, so the id cannot forge a log line", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const hostile = `https://evil.example/\n[oauth] forged line${"x".repeat(600)}`;
		isCimdClientIdAllowed(hostile);
		expect(info).toHaveBeenCalledExactlyOnceWith(
			"[oauth] refused CIMD client_id",
			JSON.stringify(hostile.slice(0, 512)),
		);
		const logged = info.mock.calls[0]?.[1] as string;
		expect(logged).not.toContain("\n");
		expect(logged.length).toBeLessThanOrEqual(512 + 2 + 2);
	});
});

/** A JWT-shaped string with these claims; the signature is never read here. */
const assertion = (claims: Record<string, string>) =>
	`e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const basic = (id: string) =>
	`Basic ${Buffer.from(`${encodeURIComponent(id)}:secret`).toString("base64")}`;

describe("unlistedCimdClientId", () => {
	const UNLISTED = "https://unlisted.example/client";

	it.each([
		["the query", { query: { client_id: UNLISTED } }],
		["the body", { body: { client_id: UNLISTED } }],
		["a path parameter", { params: { client_id: UNLISTED } }],
		["an Authorization: Basic header", { authorization: basic(UNLISTED) }],
		[
			"a client_assertion's iss/sub",
			{
				body: { client_assertion: assertion({ iss: UNLISTED, sub: UNLISTED }) },
			},
		],
		[
			"a client_assertion in the query",
			{ query: { client_assertion: assertion({ sub: UNLISTED }) } },
		],
	])("finds an unlisted URL client id in %s", (_label, sources) => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(unlistedCimdClientId(sources)).toBe(UNLISTED);
		expect(info).toHaveBeenCalledExactlyOnceWith(
			"[oauth] refused CIMD client_id",
			JSON.stringify(UNLISTED),
		);
	});

	it("passes the allowlisted client, an opaque registered id, and a request with none", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(unlistedCimdClientId({ query: { client_id: CLAUDE } })).toBeNull();
		expect(
			unlistedCimdClientId({
				body: { client_id: "aB3dE5fG7hJ9" },
				authorization: basic("aB3dE5fG7hJ9"),
			}),
		).toBeNull();
		expect(unlistedCimdClientId({})).toBeNull();
		// Not an `https:` URL, so not a metadata document: the provider decides.
		expect(
			unlistedCimdClientId({ query: { client_id: "http://plain.example/x" } }),
		).toBeNull();
		expect(info).not.toHaveBeenCalled();
	});

	it("does not let an allowlisted id in one place carry an unlisted one in another", () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		expect(
			unlistedCimdClientId({
				query: { client_id: CLAUDE },
				body: { client_assertion: assertion({ iss: UNLISTED }) },
			}),
		).toBe(UNLISTED);
	});

	it("ignores a malformed assertion or Basic header rather than throwing", () => {
		expect(
			unlistedCimdClientId({
				body: { client_assertion: "not.a-jwt!.x" },
				authorization: "Basic %%%",
			}),
		).toBeNull();
	});
});
