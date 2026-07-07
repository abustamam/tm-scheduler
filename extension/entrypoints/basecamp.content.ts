import { walkProgressPages } from "../lib/basecamp-walk";
import type { SyncRequest, SyncResponse } from "../lib/messages";

/**
 * Isolated-world content script (#107). Remembers the club GUID observed by the
 * main-world script, and on a "gavelup-sync" request from the popup runs the
 * same-origin page walk (cookies flow because this runs in the Base Camp origin)
 * and returns the collected pages + the GUID.
 */
export default defineContentScript({
	matches: [
		"https://app.basecamp.toastmasters.org/*",
		"https://basecamp.toastmasters.org/*",
	],
	runAt: "document_start",
	main() {
		let lastClubGuid: string | null = null;

		window.addEventListener("message", (event) => {
			if (event.source !== window) return;
			const data = event.data;
			if (data && data.source === "gavelup-inject" && data.type === "club-guid") {
				lastClubGuid = data.guid;
			}
		});

		function readCookie(name: string): string {
			const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
			return m ? decodeURIComponent(m[1]) : "";
		}

		browser.runtime.onMessage.addListener(
			(msg: SyncRequest, _sender, sendResponse: (r: SyncResponse) => void) => {
				if (!msg || msg.type !== "gavelup-sync") return;
				const guid = msg.guidOverride || lastClubGuid;
				(async () => {
					try {
						if (!guid) {
							sendResponse({
								ok: false,
								error:
									"Couldn't detect the Base Camp club. Open your club's Paths Progress page, or enter the club GUID manually.",
							});
							return;
						}
						const pages = await walkProgressPages({
							fetchImpl: (url, opts) => fetch(url, opts),
							guid,
							csrftoken: readCookie("csrftoken"),
						});
						sendResponse({ ok: true, guid, pages });
					} catch (err) {
						sendResponse({ ok: false, error: (err as Error).message });
					}
				})();
				return true; // async sendResponse
			},
		);
	},
});
