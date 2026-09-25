import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { H3, H3Event } from "h3";
import { serve } from "srvx";
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

describe("guardMalformedUri fast path", () => {
	it("returns a %-free request without parsing its URL", () => {
		const req = new Request(`${ORIGIN}/club/abc?x=1`);
		const spy = vi.spyOn(globalThis, "URL");
		try {
			expect(guardMalformedUri(req)).toBe(req);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("still passes a request whose only % is in the query", () => {
		const req = new Request(`${ORIGIN}/club/abc?q=%E0%A4%A`);
		expect(guardMalformedUri(req)).toBe(req);
	});

	it("carries the caller's abort signal onto the re-issued request", () => {
		const controller = new AbortController();
		const out = guardMalformedUri(
			new Request(`${ORIGIN}/%E0%A4%A`, { signal: controller.signal }),
		) as Request;
		expect(out.signal.aborted).toBe(false);
		controller.abort();
		expect(out.signal.aborted).toBe(true);
	});
});

// h3 2.0.1-rc.22 is what Nitro bundles into `.output/server`. Its decoder runs in
// the `H3Event` constructor, so constructing one is the ground truth for "would
// this request have crashed the server".
const PARITY_SAMPLES = [
	...MALFORMED,
	"/%E0%A4%A/..",
	"/x/%E0%A4%A/%2e%2e",
	"/%25%E0",
	"/club/%25ZZ",
	"/%ed%a0%80",
	"/%C0%AF",
	"/club/%E0%A4%A4",
	"/club/caf%C3%A9",
	"/a%20b",
	"/%2F",
	"/",
];

function h3Throws(request: Request): boolean {
	try {
		new H3Event(request);
		return false;
	} catch (error) {
		expect(error).toBeInstanceOf(URIError);
		return true;
	}
}

describe("h3 parity", () => {
	it.each(
		PARITY_SAMPLES,
	)("%s: the guard refuses it exactly when h3's H3Event throws", (path) => {
		const request = new Request(`${ORIGIN}${path}`);
		// The pathname h3 sees is the parsed one: dot segments are already
		// resolved, so `/%E0%A4%A/..` reaches h3 as `/`, which is fine.
		const pathname = new URL(request.url).pathname;
		expect(isDecodablePathname(pathname)).toBe(!h3Throws(request));
		expect(guardMalformedUri(request) === request).toBe(!h3Throws(request));
	});

	it("the sample set covers both outcomes", () => {
		const outcomes = PARITY_SAMPLES.map((p) =>
			h3Throws(new Request(`${ORIGIN}${p}`)),
		);
		expect(outcomes).toContain(true);
		expect(outcomes).toContain(false);
	});
});

describe("withMalformedUriGuard in front of a real h3 app", () => {
	// A real H3 app, no stubs: the route records the pathname h3 itself decoded.
	function realApp() {
		const seen: string[] = [];
		const app = new H3().all("/**", (event) => {
			seen.push(event.url.pathname);
			return new Response("not found", { status: 404 });
		});
		return { app, seen };
	}

	it("pre-fix control: the bare h3 app throws synchronously on the issue's path", () => {
		const { app } = realApp();
		expect(() => app.fetch(new Request(`${ORIGIN}/%E0%A4%A`))).toThrow(
			URIError,
		);
	});

	it.each(
		MALFORMED,
	)("GET %s gets a non-5xx answer, re-issued to the not-found path", async (path) => {
		const { app, seen } = realApp();
		const res = await withMalformedUriGuard(app.fetch)(
			new Request(`${ORIGIN}${path}`),
		);
		expect(res.status).toBeLessThan(500);
		expect(res.status).toBe(404);
		expect(seen).toEqual([MALFORMED_URI_NOT_FOUND_PATH]);
	});

	it("the issue's valid /club/%E0%A4%A4 passes through unchanged", async () => {
		const { app, seen } = realApp();
		const req = new Request(`${ORIGIN}/club/%E0%A4%A4`);
		const inner = vi.fn(app.fetch);
		await withMalformedUriGuard(inner)(req);
		expect(inner).toHaveBeenCalledWith(req);
		// h3 decoded it without throwing and routed it as the same path.
		expect(seen).toEqual(["/club/%E0%A4%A4"]);
	});

	it("a malformed POST never reaches h3", async () => {
		const { app, seen } = realApp();
		const res = await withMalformedUriGuard(app.fetch)(
			new Request(`${ORIGIN}/%E0%A4%A`, { method: "POST" }),
		);
		expect(res.status).toBe(400);
		expect(seen).toEqual([]);
	});

	it("over a real socket: srvx's Node request shape, raw path, dot segments", async () => {
		const { app, seen } = realApp();
		const server = serve({
			port: 0,
			hostname: "127.0.0.1",
			silent: true,
			fetch: withMalformedUriGuard(app.fetch),
		});
		await server.ready();
		try {
			const port = new URL(server.url as string).port;
			const get = (path: string) =>
				new Promise<number>((resolve, reject) => {
					// node:http sends the path byte-for-byte, as Cloudflare forwards it.
					http
						.get({ host: "127.0.0.1", port, path }, (res) => {
							res.resume();
							res.on("end", () => resolve(res.statusCode ?? 0));
						})
						.on("error", reject);
				});
			expect(await get("/%E0%A4%A")).toBe(404);
			expect(await get("/club/mcf-toastmasters/meeting/%E0%A4%A")).toBe(404);
			expect(await get("/%E0%A4%A/..")).toBe(404);
			expect(await get("/club/%E0%A4%A4")).toBe(404);
			expect(seen).toEqual([
				MALFORMED_URI_NOT_FOUND_PATH,
				MALFORMED_URI_NOT_FOUND_PATH,
				"/",
				"/club/%E0%A4%A4",
			]);
		} finally {
			await server.close(true);
		}
	});
});

describe("withMalformedUriGuard", () => {
	it("forwards a normal request as the same object", async () => {
		const inner = vi.fn((_req: Request) => new Response("ok"));
		const req = new Request(`${ORIGIN}/club/abc`);
		await withMalformedUriGuard(inner)(req);
		expect(inner).toHaveBeenCalledWith(req);
	});
});

const read = (rel: string) =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const stripComments = (src: string) =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("registration", () => {
	it("vite.config.ts registers the plugin in nitro()'s plugins list", () => {
		const config = stripComments(read("../../vite.config.ts"));
		const nitroCall = config.match(/nitro\(\{[\s\S]*?\}\)/)?.[0] ?? "";
		const plugins = nitroCall.match(/plugins:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
		expect(plugins).toContain('"./src/server/malformed-uri.nitro.ts"');
	});

	it("the plugin wraps nitroApp.fetch", async () => {
		const { default: plugin } = await import("./malformed-uri.nitro");
		const original = vi.fn((_req: Request) => new Response("app"));
		const nitroApp = { fetch: original } as unknown as Parameters<
			typeof plugin
		>[0];
		plugin(nitroApp);
		expect(nitroApp.fetch).not.toBe(original);
		const res = await nitroApp.fetch(
			new Request(`${ORIGIN}/%E0%A4%A`, { method: "POST" }),
		);
		expect(res.status).toBe(400);
		expect(original).not.toHaveBeenCalled();
	});
});

describe("MALFORMED_URI_NOT_FOUND_PATH", () => {
	it("routes-unmatched: no route claims it, so the router's not-found renders", () => {
		const tree = read("../routeTree.gen.ts");
		const fullPaths = [...tree.matchAll(/fullPath: '([^']*)'/g)].map(
			(m) => m[1],
		);
		expect(fullPaths.length).toBeGreaterThan(10);
		expect(fullPaths).not.toContain(MALFORMED_URI_NOT_FOUND_PATH);
		// A root splat or root param (`/$`, `/$slug`) would swallow it before the
		// root not-found could render.
		expect(fullPaths.filter((p) => p.startsWith("/$"))).toEqual([]);
	});
});
