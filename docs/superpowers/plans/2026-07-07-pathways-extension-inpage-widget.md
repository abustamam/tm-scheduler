# In-Page Sync Widget (replace the popup) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser-action popup with a Shadow-DOM widget injected on the Base Camp page (Sync button + inline status) so a multitasking officer never has to babysit a popup; move token/server settings to the extension's Options page.

**Architecture:** The existing isolated-world content script (`basecamp.content.ts`) already runs on Base Camp, observes the club GUID, and holds `walkProgressPages`. It gains a Shadow-DOM widget (WXT `createShadowRootUi`) and orchestrates the whole sync in-process: walk → message the background worker to POST → render the result inline. Settings move to a new Options page; the popup is deleted and the toolbar icon opens Options. No server changes; the pure page-walk is untouched.

**Tech Stack:** WXT (Vite + TypeScript) content-script UI (`createShadowRootUi`), `browser.*` WebExtension APIs, `browser.storage.local`. Chromium MV3 + Firefox MV2 from one codebase.

**Spec:** `docs/superpowers/specs/2026-07-07-pathways-extension-inpage-widget-design.md`

---

## Context for the implementer

- Work ONLY in the worktree `/media/rasheed-bustamam/Extra/coding/tm-scheduler-107` (branch `107-pathways-extension-autosync`). Never touch the main checkout at `/media/rasheed-bustamam/Extra/coding/tm-scheduler`.
- The extension is a self-contained WXT package under `extension/`. WXT globals `defineContentScript`, `defineBackground`, `browser`, and `createShadowRootUi` are auto-imported — do NOT import them. After adding/removing entrypoints, run `bun run postinstall` (which runs `wxt prepare`) to regenerate types, then `bunx tsc --noEmit`.
- Build a target: `cd extension && bunx wxt build -b <chrome|firefox>` → `extension/.output/chrome-mv3/` and `extension/.output/firefox-mv2/` (both gitignored).
- There are no automated tests to add (no new pure logic — the page-walk unit tests already cover the only logic). Verification = builds + manifest inspection + the manual smoke-test checklist.
- Reused, unchanged: `extension/lib/basecamp-walk.ts` (`walkProgressPages`), `extension/entrypoints/inject.content.ts` (MAIN-world GUID observer).

## File structure

- Modify `extension/lib/messages.ts` — drop the popup→content `SyncRequest`/`SyncResponse`; keep `SyncResultLike`, `IngestRequest`, `IngestResponse`; add `OpenOptionsRequest`.
- Modify `extension/entrypoints/background.ts` — keep the `gavelup-ingest` POST; make the toolbar icon open Options; handle a `gavelup-open-options` message; reword the no-token text.
- Create `extension/entrypoints/options/index.html` + `extension/entrypoints/options/main.ts` — token + server-URL settings (relocated from the popup).
- Modify `extension/entrypoints/basecamp.content.ts` — inject the widget via `createShadowRootUi`, orchestrate sync, render status; remove the `gavelup-sync` listener.
- Delete `extension/entrypoints/popup/index.html` + `extension/entrypoints/popup/main.ts`.
- Modify `extension/wxt.config.ts` — add `action: {}` (toolbar icon with no popup); Firefox gecko block unchanged.
- Modify `extension/README.md` — update the smoke-test checklist for the widget + options flow.

---

## Task 1: Message types + background (open Options; reword)

**Files:**
- Modify: `extension/lib/messages.ts`
- Modify: `extension/entrypoints/background.ts`

- [ ] **Step 1: Rewrite `extension/lib/messages.ts`** — remove the popup messages, add `OpenOptionsRequest`:

```ts
/** Message contracts between the content script and the background worker (#107). */

/** Minimal mirror of the server's SyncResult (+ optional warning). */
export interface SyncResultLike {
	matched: number;
	pathsUpserted: number;
	unmatched: { name: string; email: string | null; basecampUserId: string }[];
	warning?: string;
}

/** content script → background: POST the collected pages to GavelUp. */
export interface IngestRequest {
	type: "gavelup-ingest";
	guid: string;
	pages: unknown[];
}
export interface IngestResponse {
	ok: boolean;
	result?: SyncResultLike;
	error?: string;
}

/** content script → background: open the extension's Options page. */
export interface OpenOptionsRequest {
	type: "gavelup-open-options";
}
```

- [ ] **Step 2: Rewrite `extension/entrypoints/background.ts`** — keep the ingest POST, add the options-opening behaviors, reword the no-token message:

```ts
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
						body: JSON.stringify({ basecampClubGuid: msg.guid, pages: msg.pages }),
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
```

- [ ] **Step 3: Typecheck.** (This will fail to fully resolve until the content script stops importing the removed `SyncRequest`/`SyncResponse` — that's Task 3. For now just confirm `messages.ts` and `background.ts` themselves are internally consistent.)

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bun run postinstall && bunx tsc --noEmit 2>&1 | head -20`
Expected: any errors are ONLY in `entrypoints/basecamp.content.ts` (still importing `SyncRequest`/`SyncResponse`) and/or the popup files — NOT in `messages.ts` or `background.ts`. If `background.ts` errors on `browser.browserAction` typing, keep the `browser.action ?? browser.browserAction` guard (it is intentionally defensive); if tsc flags `browser.browserAction` as unknown, cast via `const actionApi = (browser as typeof browser & { browserAction?: typeof browser.action }).action ?? (browser as any).browserAction;` — report if you had to.

- [ ] **Step 4: Commit.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git add extension/lib/messages.ts extension/entrypoints/background.ts
git commit -m "feat(ext): background opens Options page; trim popup message types (#107)"
```

---

## Task 2: Options page

**Files:**
- Create: `extension/entrypoints/options/index.html`
- Create: `extension/entrypoints/options/main.ts`

- [ ] **Step 1: Create `extension/entrypoints/options/index.html`.**

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>GavelUp Pathways Sync — Settings</title>
		<style>
			body { font: 14px system-ui, sans-serif; max-width: 480px; margin: 24px auto; padding: 0 16px; }
			label { display: block; font-weight: 600; margin: 14px 0 4px; }
			input { width: 100%; box-sizing: border-box; padding: 8px; }
			button { margin-top: 16px; padding: 8px 14px; cursor: pointer; }
			.muted { color: #666; font-size: 13px; }
			.saved { color: #065f46; margin-left: 10px; }
		</style>
	</head>
	<body>
		<h2>GavelUp Pathways Sync</h2>
		<p class="muted">
			Set these once. Then sync from the <strong>Sync to GavelUp</strong> widget on your
			club's Base Camp Paths Progress page.
		</p>
		<label for="token">GavelUp token</label>
		<input id="token" type="password" placeholder="gup_…" />
		<label for="server">Server URL</label>
		<input id="server" type="text" placeholder="https://gavelup.app" />
		<div>
			<button id="save">Save</button>
			<span id="saved" class="saved" hidden>Saved.</span>
		</div>
		<script type="module" src="./main.ts"></script>
	</body>
</html>
```

- [ ] **Step 2: Create `extension/entrypoints/options/main.ts`.**

```ts
/** Options page (#107): one-time token + server-URL setup, saved to storage. */
const DEFAULT_SERVER = import.meta.env.WXT_GAVELUP_URL ?? "https://gavelup.app";
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
	const s = await browser.storage.local.get(["token", "serverUrl"]);
	$("token").value = (s.token as string) || "";
	$("server").value = (s.serverUrl as string) || DEFAULT_SERVER;
}

document.getElementById("save")?.addEventListener("click", async () => {
	await browser.storage.local.set({
		token: $("token").value.trim(),
		serverUrl: $("server").value.trim() || DEFAULT_SERVER,
	});
	const saved = document.getElementById("saved") as HTMLSpanElement;
	saved.hidden = false;
	setTimeout(() => {
		saved.hidden = true;
	}, 1500);
});

load();
```

- [ ] **Step 3: Regenerate types + typecheck the options files.**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bun run postinstall && bunx tsc --noEmit 2>&1 | grep -i options`
Expected: no output (no type errors in the options files). Remaining errors elsewhere (basecamp.content.ts, popup) are expected until Tasks 3–4.

- [ ] **Step 4: Commit.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git add extension/entrypoints/options/index.html extension/entrypoints/options/main.ts
git commit -m "feat(ext): Options page for token + server URL (#107)"
```

---

## Task 3: In-page widget + orchestration (`basecamp.content.ts`)

**Files:**
- Modify: `extension/entrypoints/basecamp.content.ts`

- [ ] **Step 1: Rewrite `extension/entrypoints/basecamp.content.ts`.** It keeps the GUID observer + cookie reader, adds `cssInjectionMode: "ui"` + an async `main(ctx)`, injects a Shadow-DOM widget, and orchestrates the sync (walk → background ingest → render). The old `gavelup-sync` listener is gone.

```ts
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
```

- [ ] **Step 2: Regenerate types + typecheck.**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bun run postinstall && bunx tsc --noEmit 2>&1 | grep -v popup | head`
Expected: no errors outside the still-present popup files (removed in Task 4). Specifically, `basecamp.content.ts`, `messages.ts`, and `background.ts` produce no errors. If `createShadowRootUi` is reported as an unknown name, `wxt prepare` didn't regenerate — re-run `bun run postinstall`.

- [ ] **Step 3: Commit.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git add extension/entrypoints/basecamp.content.ts
git commit -m "feat(ext): in-page Shadow-DOM sync widget replaces popup orchestration (#107)"
```

---

## Task 4: Remove the popup, wire the action, build + docs

**Files:**
- Delete: `extension/entrypoints/popup/index.html`, `extension/entrypoints/popup/main.ts`
- Modify: `extension/wxt.config.ts`
- Modify: `extension/README.md`

- [ ] **Step 1: Delete the popup entrypoint.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git rm extension/entrypoints/popup/index.html extension/entrypoints/popup/main.ts
```

- [ ] **Step 2: Add `action: {}` to `extension/wxt.config.ts`** so the toolbar icon still exists (with no popup) and `onClicked` fires. Full file:

```ts
import { defineConfig } from "wxt";

// Target GavelUp server. Prod (unset) → gavelup.app. Dev → set WXT_GAVELUP_URL,
// e.g. `WXT_GAVELUP_URL=http://localhost:3000 bun run dev`. The value is also
// read at runtime via import.meta.env.WXT_GAVELUP_URL (see background.ts).
const GAVELUP_URL = process.env.WXT_GAVELUP_URL ?? "https://gavelup.app";
const gavelupOrigin = `${new URL(GAVELUP_URL).origin}/*`;
const isDev = GAVELUP_URL.startsWith("http://");

export default defineConfig({
	manifest: ({ browser }) => ({
		name: isDev ? "GavelUp Pathways Sync (DEV)" : "GavelUp Pathways Sync",
		description:
			"Sync your club's Base Camp Pathways progress into GavelUp in one click.",
		permissions: ["storage", "activeTab"],
		host_permissions: [
			"https://basecamp.toastmasters.org/*",
			"https://app.basecamp.toastmasters.org/*",
			gavelupOrigin,
		],
		// Toolbar icon with NO popup — clicking it opens the Options page
		// (see background.ts). WXT maps `action` → `browser_action` for Firefox MV2.
		action: {},
		// Firefox-only. A stable add-on id (required to sign/install a persistent
		// .xpi), a floor that guarantees world:"MAIN" content-script support
		// (Firefox 128+), and an honest "collects no data" declaration. Gated on the
		// firefox target so the chrome-mv3 manifest is byte-for-byte unaffected.
		...(browser === "firefox"
			? {
					browser_specific_settings: {
						gecko: {
							id: "pathways-sync@gavelup.app",
							strict_min_version: "128.0",
							data_collection_permissions: { required: ["none"] },
						},
					},
				}
			: {}),
	}),
});
```

- [ ] **Step 3: Regenerate types, typecheck, and BUILD both targets.**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bun run postinstall && bunx tsc --noEmit`
Expected: exit 0 (the popup files are gone, so their errors vanish).

Run: `bunx wxt build -b chrome`
Then confirm the Chromium manifest has an action with NO popup, and an options page, and no popup.html is emitted:
`grep -q '"default_popup"' .output/chrome-mv3/manifest.json && echo "HAS POPUP (bad)" || echo "no popup (good)"`
`grep -o '"options_ui"' .output/chrome-mv3/manifest.json; grep -o '"action"' .output/chrome-mv3/manifest.json; ls .output/chrome-mv3/popup.html 2>/dev/null && echo "popup.html present (bad)" || echo "no popup.html (good)"`
Expected: "no popup (good)", an `"options_ui"` and `"action"` present, "no popup.html (good)".

Run: `bunx wxt build -b firefox`
Then: `grep -o '"browser_action"' .output/firefox-mv2/manifest.json; grep -q '"default_popup"' .output/firefox-mv2/manifest.json && echo "HAS POPUP (bad)" || echo "no popup (good)"; grep -o '"options_ui"' .output/firefox-mv2/manifest.json`
Expected: `"browser_action"` present (WXT's MV2 mapping of `action`), "no popup (good)", `"options_ui"` present.

If the Firefox manifest lacks `browser_action` (some WXT versions keep it as `action` even for MV2), that's acceptable as long as there's no `default_popup` and the toolbar entry exists — report exactly what the manifest shows.

- [ ] **Step 4: Update the smoke-test checklist in `extension/README.md`.** Replace the entire `## Manual smoke test (do before sharing a build)` section (heading + list) with:

```markdown
## Manual smoke test (do before sharing a build)

- [ ] Load unpacked (Chrome) / temporary add-on (Firefox) with no errors.
- [ ] Click the toolbar icon → the **Options** page opens; set token + server URL, Save.
- [ ] On Base Camp → your club → **Paths Progress**, a **Sync to GavelUp** widget appears
      (bottom-right). Click it → status shows "Syncing…" then "Matched N · … · U unmatched".
- [ ] With no token set, the widget prompts to set a token in options (⚙ opens Options).
- [ ] Off a Paths Progress page (GUID not seen), the widget says to open Paths Progress.
- [ ] Bad/revoked token → the widget shows the server's error; unreachable server → a network error.
- [ ] Firefox: repeat the above on the `firefox-mv2` build.
```

Also, in the `## Install (officers)` section, update step 3 (which mentions the popup) to point at the toolbar icon / Options page. Find the line beginning "3. Click the extension, paste your GavelUp **sync token**" and replace that numbered item with:

```markdown
3. Click the toolbar icon to open **Options**; paste your GavelUp **sync token** (GavelUp → Admin →
   Base Camp sync tokens), leave Server URL as `https://gavelup.app`, **Save**. Then sync from the
   **Sync to GavelUp** widget on your club's Base Camp Paths Progress page.
```

- [ ] **Step 5: Commit.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git add extension/wxt.config.ts extension/README.md extension/entrypoints/popup
git commit -m "feat(ext): remove popup, add toolbar-opens-Options action; update docs (#107)"
```

---

## Self-review (against the spec)

- **Sync from an in-page widget (not a popup)** → Task 3 (`createShadowRootUi` widget + click handler). ✅
- **Shadow DOM style isolation** → Task 3 (`cssInjectionMode: "ui"` + `createShadowRootUi`). ✅
- **Settings on the Options page** → Task 2 (`entrypoints/options/`). ✅
- **Popup removed; toolbar icon opens Options** → Task 4 (delete popup, `action: {}`) + Task 1 (`action.onClicked` → `openOptionsPage`). ✅
- **Drop the manual GUID field** → not present in the widget (Task 3 uses only the observed `lastClubGuid`). ✅
- **Content script orchestrates walk → background POST → render; `gavelup-sync` removed** → Task 3 + Task 1 (messages trimmed). ✅
- **Background ingest unchanged; add open-options paths; reword no-token** → Task 1. ✅
- **Error states rendered inline** (no token / no GUID / walk error / 401-400 / network / unmatched) → Task 3 `setStatus` branches + Task 1 background messages. ✅
- **No server changes; page-walk untouched** → no server files or `basecamp-walk.ts` in any task. ✅
- **No new automated tests; manual smoke test updated** → Task 4 Step 4. ✅
- **Out of scope (auto-sync, manual GUID, restyle, server changes)** → none present. ✅

Type consistency: `IngestRequest`/`IngestResponse`/`SyncResultLike`/`OpenOptionsRequest` defined in Task 1 `messages.ts` are the exact types imported/used by `background.ts` (Task 1) and `basecamp.content.ts` (Task 3). `walkProgressPages({ fetchImpl, guid, csrftoken })` matches the existing `lib/basecamp-walk.ts` signature. Storage keys `token` / `serverUrl` are identical across the Options page (Task 2), background (Task 1), and widget (Task 3). Placeholder scan: no TBD/TODO; every code step is complete; the two conditional notes (Task 1 Step 3 `browserAction` typing cast; Task 4 Step 3 Firefox `browser_action` mapping) are bounded verify-and-report instructions with explicit accept conditions, not open placeholders.
