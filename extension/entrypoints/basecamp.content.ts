import { walkProgressPages } from "../lib/basecamp-walk";
import type { IngestRequest, IngestResponse } from "../lib/messages";

/**
 * Isolated-world content script (#107). Observes the club GUID posted by the
 * MAIN-world inject script, and injects a Shadow-DOM "Sync to GavelUp" widget on
 * the Base Camp page. On click it walks the progress pages (same-origin, cookies
 * flow), asks the background worker to POST them, and renders the result inline —
 * no popup to babysit.
 */
export default defineContentScript({
	matches: [
		"https://app.basecamp.toastmasters.org/*",
		"https://basecamp.toastmasters.org/*",
	],
	runAt: "document_start",
	cssInjectionMode: "ui",
	async main(ctx) {
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

		const ui = await createShadowRootUi(ctx, {
			name: "gavelup-sync-widget",
			position: "inline",
			anchor: "body",
			onMount: (container) => {
				container.appendChild(buildWidget());
			},
		});

		// Body may not exist yet at document_start — mount once the DOM is ready.
		if (document.body) {
			ui.mount();
		} else {
			document.addEventListener("DOMContentLoaded", () => ui.mount(), { once: true });
		}

		function buildWidget(): HTMLElement {
			const root = document.createElement("div");
			root.setAttribute(
				"style",
				"position:fixed;bottom:16px;right:16px;z-index:2147483647;font:13px system-ui,sans-serif;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.15);padding:10px 12px;max-width:280px;",
			);

			const row = document.createElement("div");
			row.setAttribute("style", "display:flex;align-items:center;gap:8px;");
			const btn = document.createElement("button");
			btn.textContent = "Sync to GavelUp";
			btn.setAttribute(
				"style",
				"cursor:pointer;padding:6px 10px;border-radius:6px;border:1px solid #6d28d9;background:#6d28d9;color:#fff;font-weight:600;",
			);
			const gear = document.createElement("button");
			gear.textContent = "⚙";
			gear.title = "Settings";
			gear.setAttribute(
				"style",
				"cursor:pointer;padding:4px 8px;border-radius:6px;border:1px solid #d1d5db;background:#f9fafb;color:#374151;",
			);
			gear.addEventListener("click", () => {
				browser.runtime.sendMessage({ type: "gavelup-open-options" });
			});
			row.append(btn, gear);

			const status = document.createElement("div");
			status.setAttribute("style", "margin-top:8px;white-space:pre-wrap;line-height:1.35;");
			root.append(row, status);

			function setStatus(text: string, color = "#374151") {
				status.textContent = text;
				status.style.color = color;
			}

			btn.addEventListener("click", async () => {
				const { token } = await browser.storage.local.get("token");
				if (!token) {
					setStatus("Set your GavelUp token in the extension's options (⚙).", "#b45309");
					return;
				}
				const guid = lastClubGuid;
				if (!guid) {
					setStatus("Open your club's Paths Progress page, then Sync.", "#b45309");
					return;
				}
				btn.disabled = true;
				setStatus("Syncing…");
				try {
					const pages = await walkProgressPages({
						fetchImpl: (url, opts) => fetch(url, opts),
						guid,
						csrftoken: readCookie("csrftoken"),
					});
					const res = (await browser.runtime.sendMessage({
						type: "gavelup-ingest",
						guid,
						pages,
					} satisfies IngestRequest)) as IngestResponse;
					if (!res?.ok || !res.result) {
						setStatus(res?.error || "Sync failed.", "#b91c1c");
						return;
					}
					const r = res.result;
					const base = `Matched ${r.matched} · ${r.pathsUpserted} path(s) updated · ${r.unmatched.length} unmatched`;
					setStatus(r.warning ? `${base}\n⚠ ${r.warning}` : base, r.warning ? "#b45309" : "#065f46");
				} catch (err) {
					setStatus((err as Error).message, "#b91c1c");
				} finally {
					btn.disabled = false;
				}
			});

			return root;
		}
	},
});
