// Nitro runtime plugin — a request whose path carries an invalid percent-escape
// (`/%E0%A4%A`) gets the branded 404 instead of a dropped socket (#895).
//
// h3 decodes the pathname with `decodeURI` in the `H3Event` CONSTRUCTOR, which
// `H3Core["~request"]` calls outside its own try/catch. The `URIError` is thrown
// synchronously out of `nitroApp.fetch`, surfaces as an `uncaughtException`, and
// the request is never answered — so Cloudflare, in front of gavelup.app, reports
// a 502 that blames the origin. Every Nitro hook (`request`, `error`) runs AFTER
// the event exists, so none of them can see this; the only seam in front of the
// constructor is `nitroApp.fetch` itself, which the node-server entry reads
// after plugins have run. This plugin wraps it.
//
// A malformed GET/HEAD is re-issued as a GET for a path no route matches, so the
// router renders its own `defaultNotFoundComponent` (`src/router.tsx`) with a 404
// status — the same page as any other unknown URL. Any other method gets a plain
// 400: there is no page to render for a POST to a path that cannot be decoded.
import { definePlugin } from "nitro";

/**
 * The path a malformed request is re-issued against. It must match no route, so
 * the router's root not-found renders. `routes-unmatched` in the test pins that.
 */
export const MALFORMED_URI_NOT_FOUND_PATH = "/__malformed-uri";

/**
 * Whether h3 can decode this pathname. Mirrors `decodePathname` in h3
 * 2.0.1-rc.22 (the version Nitro bundles here), including its `%25` escape. The
 * h3-parity test in `malformed-uri.test.ts` constructs a real `H3Event` for each
 * sample, so an h3 upgrade that changes the decoder fails there rather than here.
 */
export function isDecodablePathname(pathname: string): boolean {
	if (!pathname.includes("%")) return true;
	try {
		decodeURI(
			pathname.includes("%25") ? pathname.replace(/%25/g, "%2525") : pathname,
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns the request unchanged when its path decodes; otherwise the request the
 * app should serve instead (GET/HEAD) or the response to send outright.
 */
export function guardMalformedUri(request: Request): Request | Response {
	// Fast path: no `%` anywhere in the URL means nothing for h3 to decode, so
	// the common request pays for one substring scan and no URL parse.
	if (!request.url.includes("%")) return request;
	if (isDecodablePathname(h3Pathname(request))) return request;

	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Bad Request: malformed URL encoding", {
			status: 400,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}

	const url = new URL(request.url);
	url.pathname = MALFORMED_URI_NOT_FOUND_PATH;
	url.search = "";
	return new Request(url, {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
	});
}

/**
 * The pathname h3's `H3Event` will decode: srvx's parsed `_url` when the request
 * carries one (every request on the Node server does), else the WHATWG parse of
 * `request.url`. Reading the same object h3 reads keeps the two from disagreeing
 * about dot segments or characters one parser normalises and the other does not.
 */
function h3Pathname(request: Request): string {
	const parsed = (request as Request & { _url?: unknown })._url;
	return parsed instanceof URL
		? parsed.pathname
		: new URL(request.url).pathname;
}

type Fetch = (request: Request) => Response | Promise<Response>;

/** Wraps an app `fetch` so a malformed path never reaches h3's decoder. */
export function withMalformedUriGuard(fetch: Fetch): Fetch {
	return (request) => {
		const guarded = guardMalformedUri(request);
		return guarded instanceof Response ? guarded : fetch(guarded);
	};
}

export default definePlugin((nitroApp) => {
	nitroApp.fetch = withMalformedUriGuard(nitroApp.fetch);
});
