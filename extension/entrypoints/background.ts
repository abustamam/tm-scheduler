import type { IngestRequest, IngestResponse } from "../lib/messages";

/**
 * Background service worker (#107). Receives collected Base Camp pages from the
 * popup and POSTs them to GavelUp's ingest endpoint with the club Bearer token.
 * Runs in the extension origin, so the cross-origin POST is allowed by
 * host_permissions (no CORS handling needed on the server).
 */
const DEFAULT_SERVER = import.meta.env.WXT_GAVELUP_URL ?? "https://gavelup.app";

export default defineBackground(() => {
	browser.runtime.onMessage.addListener(
		(msg: IngestRequest, _sender, sendResponse: (r: IngestResponse) => void) => {
			if (!msg || msg.type !== "gavelup-ingest") return;
			(async () => {
				const stored = await browser.storage.local.get(["token", "serverUrl"]);
				const token = (stored.token as string) || "";
				const serverUrl = (stored.serverUrl as string) || DEFAULT_SERVER;
				if (!token) {
					sendResponse({ ok: false, error: "No GavelUp token set. Paste one in the popup." });
					return;
				}
				try {
					const res = await fetch(`${serverUrl}/api/pathways/ingest`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ basecampClubGuid: msg.guid, pages: msg.pages }),
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok) {
						sendResponse({ ok: false, error: json.error || `Server returned ${res.status}.` });
						return;
					}
					sendResponse({ ok: true, result: json });
				} catch (err) {
					sendResponse({ ok: false, error: `Could not reach GavelUp: ${(err as Error).message}` });
				}
			})();
			return true; // async sendResponse
		},
	);
});
