/**
 * What `/api/mcp` says when it cannot judge an OAuth token at all (#843).
 *
 * A verifier that could not run — the key set unreadable, the JWKS fetch
 * refused — is GavelUp's outage, not the caller's bad credential. It must be a
 * 500 with no challenge: a 401 carrying `WWW-Authenticate` would send
 * claude.ai back through consent for nothing, on every call, for as long as
 * the outage lasts. And a failure AFTER a good token must not be logged as a
 * verification failure, which is where a diagnosis would then start.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { serveWithOAuthCredential } = vi.hoisted(() => ({
	serveWithOAuthCredential: vi.fn(),
}));
vi.mock("#/db", () => ({ db: {} }));
vi.mock("./oauth-credential", () => ({ serveWithOAuthCredential }));

const { handleMcpRequest } = await import("./handle-request");

const request = () =>
	new Request("https://club.test/api/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer eyJhbGciOiJFZERTQSJ9.e30.c2ln",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});

afterEach(() => {
	vi.restoreAllMocks();
	serveWithOAuthCredential.mockReset();
});

describe("an OAuth verifier outage", () => {
	it("is a 500 with no challenge, not a consent-triggering 401", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		serveWithOAuthCredential.mockRejectedValue(new Error("jwks down"));
		const res = await handleMcpRequest(request());
		expect(res.status).toBe(500);
		expect(res.headers.get("www-authenticate")).toBeNull();
		expect(log).toHaveBeenCalledWith(
			"[mcp] could not verify an OAuth access token:",
			expect.any(Error),
		);
	});

	it("does not report a failure after verification as a verification failure", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		// A verified grant whose request then fails inside the handler. With
		// `#/db` stubbed empty, resolving the user throws.
		serveWithOAuthCredential.mockImplementation(
			(req: Request, handler: (r: Request, g: unknown) => Promise<Response>) =>
				handler(req, { userId: "u", clientId: "c", tokenId: "j" }),
		);
		const res = await handleMcpRequest(request());
		expect(res.status).toBe(500);
		expect(log).not.toHaveBeenCalledWith(
			"[mcp] could not verify an OAuth access token:",
			expect.anything(),
		);
	});
});
