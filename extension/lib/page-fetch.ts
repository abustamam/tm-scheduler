/**
 * The fetch a content script uses to read the site it runs on, as the page would.
 *
 * Chrome's content-script `fetch` already goes out as the page: same origin, the
 * page's cookies. Firefox's goes out as the extension, so easy-speak.org's
 * Cloudflare front answers 403 to it, and the export stops at its first request
 * ("Could not read which club and account this is: status 403"). Firefox gives
 * content scripts `content.fetch` for exactly this; Chrome has no `content`, so it
 * keeps the plain `fetch`.
 */
export interface PageGlobal {
	fetch: typeof fetch;
	content?: { fetch?: typeof fetch };
}

export function pageFetch(
	scope: PageGlobal,
): (url: string, init: RequestInit) => Promise<Response> {
	// Called as methods, never detached: a bare `fetch` reference throws "Illegal invocation".
	return (url, init) =>
		scope.content?.fetch ? scope.content.fetch(url, init) : scope.fetch(url, init);
}
