import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	guardMalformedUri,
	isDecodablePathname,
	MALFORMED_URI_NOT_FOUND_PATH,
	withMalformedUriGuard,
} from "./malformed-uri.nitro";

const ORIGIN = "http://localhost:3000";

// The three paths #895 reproduced against gavelup.app, plus the `%ZZ` shape
// Cloudflare happened to 400 itself — the origin must not depend on that.
const MALFORMED = [
	"/%E0%A4%A",
	"/club/%E0%A4%A",
	"/club/mcf-toastmasters/meeting/%E0%A4%A",
	"/club/%ZZ",
	"/%",
];

describe("isDecodablePathname", () => {
	it.each(MALFORMED)("refuses %s, which h3's decodeURI throws on", (path) => {
		expect(() => decodeURI(path)).toThrow(URIError);
		expect(isDecodablePathname(path)).toBe(false);
	});

	it.each([
		"/",
		"/club/abc",
		"/club/caf%C3%A9",
		"/resources/a%20b",
		// h3 escapes %25 before decoding, so a literal "%25" followed by junk is fine.
		"/club/%25ZZ",
	])("accepts %s", (path) => {
		expect(isDecodablePathname(path)).toBe(true);
	});
});

describe("guardMalformedUri", () => {
	it("passes a decodable request through untouched", () => {
		const req = new Request(`${ORIGIN}/club/abc?x=1`);
		expect(guardMalformedUri(req)).toBe(req);
	});

	it.each(MALFORMED)("re-issues GET %s against the not-found path", (path) => {
		const req = new Request(`${ORIGIN}${path}?q=1`, {
			headers: { cookie: "session=abc", accept: "text/html" },
		});
		const out = guardMalformedUri(req);
		expect(out).toBeInstanceOf(Request);
		const url = new URL((out as Request).url);
		expect(url.origin).toBe(ORIGIN);
		expect(url.pathname).toBe(MALFORMED_URI_NOT_FOUND_PATH);
		expect(url.search).toBe("");
		expect((out as Request).method).toBe("GET");
		// Headers carry over so the 404 renders for the same viewer.
		expect((out as Request).headers.get("cookie")).toBe("session=abc");
		// And the replacement is itself decodable, so h3 accepts it.
		expect(isDecodablePathname(url.pathname)).toBe(true);
	});

	it("keeps HEAD as HEAD", () => {
		const out = guardMalformedUri(
			new Request(`${ORIGIN}/%E0%A4%A`, { method: "HEAD" }),
		);
		expect((out as Request).method).toBe("HEAD");
	});

	it.each([
		"POST",
		"PUT",
		"DELETE",
		"PATCH",
	])("answers %s on a malformed path with a 400", async (method) => {
		const out = guardMalformedUri(
			new Request(`${ORIGIN}/%E0%A4%A`, { method, body: "x" }),
		);
		expect(out).toBeInstanceOf(Response);
		expect((out as Response).status).toBe(400);
		expect(await (out as Response).text()).toMatch(/malformed/i);
	});
});

describe("withMalformedUriGuard", () => {
	it("never hands the inner fetch a path h3 would throw on", async () => {
		// Stand-in for h3: throws synchronously exactly as the H3Event constructor does.
		const inner = vi.fn((req: Request) => {
			decodeURI(new URL(req.url).pathname);
			return new Response("ok", { status: 404 });
		});
		const fetch = withMalformedUriGuard(inner);
		for (const path of MALFORMED) {
			const res = await fetch(new Request(`${ORIGIN}${path}`));
			expect(res.status).toBe(404);
		}
		expect(inner).toHaveBeenCalledTimes(MALFORMED.length);
	});

	it("short-circuits a malformed POST without calling the app", async () => {
		const inner = vi.fn(() => new Response("ok"));
		const res = await withMalformedUriGuard(inner)(
			new Request(`${ORIGIN}/%E0%A4%A`, { method: "POST" }),
		);
		expect(res.status).toBe(400);
		expect(inner).not.toHaveBeenCalled();
	});

	it("forwards a normal request as the same object", async () => {
		const inner = vi.fn((_req: Request) => new Response("ok"));
		const req = new Request(`${ORIGIN}/club/abc`);
		await withMalformedUriGuard(inner)(req);
		expect(inner).toHaveBeenCalledWith(req);
	});
});

describe("MALFORMED_URI_NOT_FOUND_PATH", () => {
	it("routes-unmatched: no route claims it, so the router's not-found renders", () => {
		const tree = readFileSync(
			fileURLToPath(new URL("../routeTree.gen.ts", import.meta.url)),
			"utf8",
		);
		const fullPaths = [...tree.matchAll(/fullPath: '([^']*)'/g)].map(
			(m) => m[1],
		);
		expect(fullPaths.length).toBeGreaterThan(10);
		expect(fullPaths).not.toContain(MALFORMED_URI_NOT_FOUND_PATH);
		// A root splat would swallow it before the root not-found could render.
		expect(fullPaths).not.toContain("/$");
	});
});
