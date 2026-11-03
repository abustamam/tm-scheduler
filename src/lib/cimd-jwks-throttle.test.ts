// The JWKS fetch cap (#1486). The end-to-end half — a flood of unknown-`kid`
// assertions fetches ChatGPT's keys at most once — is in
// `oauth-consent.integration.test.ts`.
import { describe, expect, it, vi } from "vitest";
import {
	JWKS_MIN_INTERVAL_MS,
	throttleJwksFetches,
} from "./cimd-jwks-throttle";

const DOC = "https://chatgpt.com/oauth/client.json";
const JWKS = "https://chatgpt.com/oauth/jwks.json";

function setup() {
	let clock = 1_000_000;
	const inner = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response("{}"),
	);
	const fetch = throttleJwksFetches(
		inner,
		(url) => url === DOC,
		() => clock,
	);
	return { fetch, inner, advance: (ms: number) => (clock += ms) };
}

describe("throttleJwksFetches", () => {
	it("fetches a JWKS once, then refuses until the window has passed", async () => {
		const { fetch, inner, advance } = setup();
		await fetch(JWKS);
		await expect(fetch(JWKS)).rejects.toThrow("JWKS refetch throttled");
		advance(JWKS_MIN_INTERVAL_MS - 1);
		await expect(fetch(JWKS)).rejects.toThrow("JWKS refetch throttled");
		advance(1);
		await fetch(JWKS);
		expect(inner).toHaveBeenCalledTimes(2);
	});

	it("throttles concurrent fetches from the moment the first one starts", async () => {
		const { fetch, inner } = setup();
		const results = await Promise.allSettled([fetch(JWKS), fetch(JWKS)]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("never throttles a metadata document, which the plugin budgets itself", async () => {
		const { fetch, inner } = setup();
		await fetch(DOC);
		await fetch(DOC);
		await fetch(new Request(DOC));
		expect(inner).toHaveBeenCalledTimes(3);
	});

	it("keeps a separate window per JWKS URL", async () => {
		const { fetch, inner } = setup();
		await fetch(JWKS);
		await fetch("https://example.com/other-jwks.json");
		expect(inner).toHaveBeenCalledTimes(2);
	});
});
