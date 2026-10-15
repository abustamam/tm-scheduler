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
	return (url, init) => {
		const content = firefoxContent(scope);
		return content ? content.fetch(url, init) : scope.fetch(url, init);
	};
}

/**
 * Firefox's `content`, or undefined. In Chrome `content` is a named window property when the
 * page has an element or frame of that name: a form whose field is named `fetch` makes it a
 * non-function, and a cross-origin frame makes reading it throw.
 */
function firefoxContent(scope: PageGlobal): { fetch: typeof fetch } | undefined {
	try {
		const content = scope.content;
		return typeof content?.fetch === "function" ? (content as { fetch: typeof fetch }) : undefined;
	} catch {
		return undefined;
	}
}
