import { EASY_SPEAK_MATCHES } from "../lib/easy-speak-hosts";
import {
	idbStore,
	type Progress,
	resumeState,
	runExport,
} from "../lib/easy-speak-walk";

/**
 * Easy-Speak export mode (#1047), the second mode beside the Base Camp sync.
 * Internal only, like the Pathways mode (ADR-0025): unlisted, run by the
 * maintainer or an officer of the maintainer's clubs. A member account is enough.
 *
 * Injects a small "Export this club for GavelUp" widget on a signed-in
 * easy-speak.org page. One click walks the club (sequentially, 1s between
 * requests, same-origin with the page's cookies) and downloads one JSON file.
 * It posts nothing anywhere: upload is a later step, by a superadmin.
 */
export default defineContentScript({
	matches: [...EASY_SPEAK_MATCHES],
	runAt: "document_idle",
	cssInjectionMode: "ui",
	async main(ctx) {
		// Only the club pages have the left panel. A popup (a request form, a profile) does not.
		if (!document.querySelector("#portal-left-panel span.name a")) return;

		const store = idbStore();
		// One id per page load: the lease that keeps a second tab from walking too.
		const owner = crypto.randomUUID();
		const resume = await resumeState(store, owner, Date.now());

		const ui = await createShadowRootUi(ctx, {
			name: "gavelup-easy-speak-export",
			position: "inline",
			anchor: "body",
			onMount: (container) => {
				container.appendChild(buildWidget(resume.kind === "auto" || resume.kind === "manual"));
			},
		});
		ui.mount();

		function buildWidget(hasSession: boolean): HTMLElement {
			const root = document.createElement("div");
			root.setAttribute(
				"style",
				"position:fixed;bottom:16px;right:16px;z-index:2147483647;font:13px system-ui,sans-serif;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.15);padding:10px 12px;max-width:300px;",
			);
			const row = document.createElement("div");
			row.setAttribute("style", "display:flex;align-items:center;gap:8px;");
			const btn = document.createElement("button");
			btn.textContent = hasSession
				? "Resume export"
				: "Export this club for GavelUp";
			btn.setAttribute(
				"style",
				"cursor:pointer;padding:6px 10px;border-radius:6px;border:1px solid #6d28d9;background:#6d28d9;color:#fff;font-weight:600;",
			);
			row.append(btn);
			const status = document.createElement("div");
			status.setAttribute(
				"style",
				"margin-top:8px;white-space:pre-wrap;line-height:1.35;",
			);
			root.append(row, status);

			function setStatus(msg: string, color = "#374151") {
				status.textContent = msg;
				status.style.color = color;
			}
			const onProgress = (p: Progress) =>
				setStatus(`${p.done} / ${p.total} pages\n${p.label}`);

			async function start() {
				btn.disabled = true;
				setStatus("Starting...");
				try {
					const { bundle, fileName } = await runExport({
						fetchImpl: (url, init) => fetch(url, init),
						parseHtml: (html) =>
							new DOMParser().parseFromString(html, "text/html"),
						store,
						owner,
						sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
						now: Date.now,
						onProgress,
					});
					download(fileName, JSON.stringify(bundle));
					setStatus(
						`Saved ${fileName}\n${bundle.meetings.length} meetings, ${bundle.speechRequests.length} speeches, ${bundle.people.length} people.`,
						"#065f46",
					);
					btn.textContent = "Export this club for GavelUp";
				} catch (err) {
					setStatus(
						`${(err as Error).message}\nPress Resume to continue where it stopped.`,
						"#b91c1c",
					);
					btn.textContent = "Resume export";
				} finally {
					btn.disabled = false;
				}
			}
			btn.addEventListener("click", start);

			// A reload mid-walk: pick up at once. A stale session waits for the button,
			// and so does a store another tab is walking right now.
			if (resume.kind === "auto") void start();
			else if (resume.kind === "manual") {
				setStatus(`An unfinished export is stored (${resume.session.pages} pages).`);
			} else if (resume.kind === "elsewhere") {
				setStatus("Another Easy-Speak tab is exporting this club right now.");
			}
			return root;
		}

		function download(fileName: string, json: string) {
			const url = URL.createObjectURL(
				new Blob([json], { type: "application/json" }),
			);
			const a = document.createElement("a");
			a.href = url;
			a.download = fileName;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		}
	},
});
