import type { IngestRequest, IngestResponse, SyncRequest, SyncResponse } from "../../lib/messages";

/** Popup controller (#107): persist settings, trigger a sync on the active tab. */
const DEFAULT_SERVER = import.meta.env.WXT_GAVELUP_URL ?? "https://gavelup.app";
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
	const s = await browser.storage.local.get(["token", "serverUrl", "guidOverride"]);
	$("token").value = (s.token as string) || "";
	$("server").value = (s.serverUrl as string) || DEFAULT_SERVER;
	$("guid").value = (s.guidOverride as string) || "";
}

async function persist() {
	await browser.storage.local.set({
		token: $("token").value.trim(),
		serverUrl: $("server").value.trim() || DEFAULT_SERVER,
		guidOverride: $("guid").value.trim(),
	});
}

function setResult(text: string, cls = "") {
	const el = document.getElementById("result") as HTMLDivElement;
	el.textContent = text;
	el.className = `result ${cls}`;
}

document.getElementById("save")?.addEventListener("click", async () => {
	await persist();
	setResult("Settings saved.");
});

document.getElementById("sync")?.addEventListener("click", async () => {
	setResult("Syncing…");
	await persist();

	const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id || !/basecamp\.toastmasters\.org/.test(tab.url || "")) {
		setResult("Open your Base Camp Paths Progress page first.", "err");
		return;
	}

	// 1) Ask the content script to walk the Base Camp pages.
	let walk: SyncResponse | undefined;
	try {
		walk = (await browser.tabs.sendMessage(tab.id, {
			type: "gavelup-sync",
			guidOverride: $("guid").value.trim() || null,
		} satisfies SyncRequest)) as SyncResponse;
	} catch {
		setResult("Couldn't reach the Base Camp page — reload it and retry.", "err");
		return;
	}
	if (!walk?.ok) {
		setResult(walk?.error || "Base Camp sync failed.", "err");
		return;
	}

	// 2) Hand the pages to the background worker to POST to GavelUp.
	const ingest = (await browser.runtime.sendMessage({
		type: "gavelup-ingest",
		guid: walk.guid ?? "",
		pages: walk.pages ?? [],
	} satisfies IngestRequest)) as IngestResponse;
	if (!ingest?.ok || !ingest.result) {
		setResult(ingest?.error || "Upload failed.", "err");
		return;
	}

	const r = ingest.result;
	const base = `Matched ${r.matched} · ${r.pathsUpserted} path(s) updated · ${r.unmatched.length} unmatched`;
	setResult(r.warning ? `${base}\n⚠ ${r.warning}` : base, r.warning ? "warn" : "");
});

load();
