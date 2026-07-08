import type {
	IngestRequest,
	IngestResponse,
	OpenOptionsRequest,
} from "../lib/messages";

/**
 * Background worker (#107). POSTs collected Base Camp pages to GavelUp's ingest
 * endpoint with the club Bearer token (host_permissions → no CORS). Also opens
 * the Options page — from the toolbar-icon click and from a content-script
 * request (content scripts can't call openOptionsPage themselves).
 */
const DEFAULT_SERVER = import.meta.env.WXT_GAVELUP_URL ?? "https://gavelup.app";

export default defineBackground(() => {
	// Toolbar icon → open settings (there is no popup). `action` (MV3) vs
	// `browserAction` (MV2) — support whichever the browser exposes.
	const actionApi = browser.action ?? browser.browserAction;
	actionApi?.onClicked.addListener(() => {
		browser.runtime.openOptionsPage();
	});

	browser.runtime.onMessage.addListener(
		(
			msg: IngestRequest | OpenOptionsRequest,
			_sender,
			sendResponse: (r: IngestResponse) => void,
		) => {
			if (!msg) return;

			if (msg.type === "gavelup-open-options") {
				browser.runtime.openOptionsPage();
				return; // no response needed
			}

			if (msg.type !== "gavelup-ingest") return;
			(async () => {
				const stored = await browser.storage.local.get(["token", "serverUrl"]);
				const token = (stored.token as string) || "";
				const serverUrl = (stored.serverUrl as string) || DEFAULT_SERVER;
				if (!token) {
					sendResponse({
						ok: false,
						error: "No GavelUp token set — set one in the extension's options.",
					});
					return;
				}
				try {
					const res = await fetch(`${serverUrl}/api/pathways/ingest`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({
							basecampClubGuid: msg.guid,
							pages: msg.pages,
							...(msg.details ? { details: msg.details } : {}),
						}),
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok) {
						sendResponse({ ok: false, error: json.error || `Server returned ${res.status}.` });
						return;
					}
					sendResponse({ ok: true, result: json });
				} catch (err) {
					sendResponse({
						ok: false,
						error: `Could not reach GavelUp: ${(err as Error).message}`,
					});
				}
			})();
			return true; // async sendResponse
		},
	);
});
