/**
 * Main-world content script (#107): the isolated content script can't see the
 * page's own window.fetch/XHR, so this runs in the page world, wraps them, and
 * forwards any observed Base Camp `club` GUID to the isolated script via
 * window.postMessage. It never blocks or alters the page's requests.
 */
export default defineContentScript({
	matches: [
		"https://app.basecamp.toastmasters.org/*",
		"https://basecamp.toastmasters.org/*",
	],
	world: "MAIN",
	runAt: "document_start",
	main() {
		function reportFromUrl(rawUrl: string) {
			try {
				const u = new URL(rawUrl, location.href);
				if (u.pathname.includes("/api/bcm/progress")) {
					const guid = u.searchParams.get("club");
					if (guid) {
						window.postMessage(
							{ source: "gavelup-inject", type: "club-guid", guid },
							"*",
						);
					}
				}
			} catch {
				/* ignore non-URL inputs */
			}
		}

		const origFetch = window.fetch;
		window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
			const input = args[0];
			const url = typeof input === "string" ? input : (input as Request)?.url;
			if (url) reportFromUrl(url);
			return origFetch.apply(this as typeof globalThis, args);
		};

		const origOpen = XMLHttpRequest.prototype.open;
		// biome-ignore lint/suspicious/noExplicitAny: XHR.open overload signature
		XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
			const url = args[1];
			if (typeof url === "string") reportFromUrl(url);
			return origOpen.apply(this, args as never);
		};
	},
});
