// The CIMD pre-fetch gate (#852). The end-to-end half — that a refused id is
// never fetched and writes no client — is in `oauth-consent.integration.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CIMD_ALLOWED_CLIENT_IDS,
	isCimdClientIdAllowed,
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
