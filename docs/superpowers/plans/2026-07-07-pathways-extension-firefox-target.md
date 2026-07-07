# Pathways Sync Extension — Firefox Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WXT extension a first-class dual-target — Chromium (MV3) and Firefox (MV2) — from one codebase, with the Firefox manifest carrying a stable add-on id, a `strict_min_version` that guarantees `world:"MAIN"` support, and an honest "no data collected" declaration; plus build/zip scripts and install/signing docs.

**Architecture:** Config + tooling only. Firefox ≥128 supports the `world:"MAIN"` content script (even under MV2), and `wxt build -b firefox` already translates the MV3→MV2 differences from the existing source — so NO content-script, background, or popup code changes. The Firefox-specific manifest keys are added conditionally (only when WXT builds the `firefox` target) so the `chrome-mv3` output is unchanged.

**Tech Stack:** WXT (Vite + TypeScript), Bun. Self-contained extension package in `extension/`.

**Spec:** `docs/superpowers/specs/2026-07-07-pathways-extension-firefox-target-design.md`

---

## Context for the implementer

- Work ONLY in the worktree `/media/rasheed-bustamam/Extra/coding/tm-scheduler-107` (branch `107-pathways-extension-autosync`). Never touch the main checkout at `/media/rasheed-bustamam/Extra/coding/tm-scheduler`.
- The extension is a self-contained WXT package under `extension/` with its own `package.json`. Its deps are already installed. Build with `cd extension && bunx wxt build -b <chrome|firefox>`; outputs land in `extension/.output/chrome-mv3/` and `extension/.output/firefox-mv2/` (both gitignored).
- There are no automated tests to add (no new logic). Verification = building each target and inspecting the generated `manifest.json`.
- WXT's `manifest` config option accepts a **function** `({ browser, manifestVersion, mode, command }) => (manifestObject)`; use `browser === "firefox"` to gate Firefox-only keys.

## File structure

- Modify `extension/package.json` — add a `version` field (clears WXT's `"0.0.0"` warning; WXT reads the package version).
- Modify `extension/wxt.config.ts` — convert `manifest` to a function that adds `browser_specific_settings.gecko` (id + `strict_min_version` + `data_collection_permissions`) only for the Firefox target.
- Modify root `package.json` — add `ext:build:firefox` and `ext:zip:firefox` convenience scripts.
- Modify `extension/README.md` — add a Firefox install/dev/signing section and a Firefox smoke-test line.

---

## Task 1: Version + Firefox-only manifest settings

**Files:**
- Modify: `extension/package.json`
- Modify: `extension/wxt.config.ts`

- [ ] **Step 1: Add a version to `extension/package.json`.** Insert a `"version"` field after `"type"`. The result:

```json
{
	"name": "gavelup-pathways-sync-extension",
	"private": true,
	"type": "module",
	"version": "0.1.0",
	"scripts": {
		"dev": "wxt",
		"build": "wxt build",
		"zip": "wxt zip",
		"test": "vitest run",
		"postinstall": "wxt prepare"
	},
	"devDependencies": {
		"typescript": "^6.0.3",
		"vitest": "^4.1.10",
		"wxt": "^0.20.27"
	}
}
```

- [ ] **Step 2: Rewrite `extension/wxt.config.ts`** so `manifest` is a function that conditionally adds the Firefox-only `browser_specific_settings.gecko` block. Full file:

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

- [ ] **Step 3: Build the Chromium target and confirm it's unchanged.**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bunx wxt build -b chrome`
Then inspect: `cat .output/chrome-mv3/manifest.json`
Expected: `"version":"0.1.0"` is present; there is **NO** `browser_specific_settings` key; `host_permissions`, the two content scripts (one with `"world":"MAIN"`), background, and action are unchanged. Confirm with:
`grep -q '"version":"0.1.0"' .output/chrome-mv3/manifest.json && ! grep -q browser_specific_settings .output/chrome-mv3/manifest.json && echo "CHROME OK"`
Expected: prints `CHROME OK`.

- [ ] **Step 4: Build the Firefox target and confirm the gecko block + MAIN-world script.**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bunx wxt build -b firefox`
Then inspect: `cat .output/firefox-mv2/manifest.json`
Expected: `"manifest_version":2`; `"version":"0.1.0"`; a `browser_specific_settings.gecko` object with `"id":"pathways-sync@gavelup.app"`, `"strict_min_version":"128.0"`, and a data-collection declaration; and the second content script still carries `"world":"MAIN"`. Confirm with:
`grep -q '"id":"pathways-sync@gavelup.app"' .output/firefox-mv2/manifest.json && grep -q '"strict_min_version":"128.0"' .output/firefox-mv2/manifest.json && grep -q '"world":"MAIN"' .output/firefox-mv2/manifest.json && echo "FIREFOX OK"`
Expected: prints `FIREFOX OK`.

- [ ] **Step 5: Confirm the data-collection warning is gone (and fix placement if WXT disagrees).**

The Firefox build previously warned: *"Firefox requires data_collection_permissions for new extensions…"*. After Step 4, that warning should NOT appear in the `bunx wxt build -b firefox` output, and `.output/firefox-mv2/manifest.json` should contain a `data_collection_permissions` declaration (under `browser_specific_settings.gecko`).

If the warning persists or `data_collection_permissions` is missing from the manifest, WXT expects it in a different place than assumed here — consult the WXT config docs / the manifest WXT actually emits and move the `data_collection_permissions` key accordingly (it is Firefox-only either way; keep it gated to `browser === "firefox"`). Re-run Step 4's grep until `FIREFOX OK` prints AND the manifest contains the data-collection declaration AND the build no longer warns about it. Do not proceed until this holds; report what you had to change.

- [ ] **Step 6: Typecheck the extension** (the config is TS):

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107/extension && bunx tsc --noEmit`
Expected: exit 0. (If `browser` in the manifest function is untyped/`any`, that's fine; if tsc errors on the function form, ensure it returns a single object literal as shown.)

- [ ] **Step 7: Commit.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git add extension/package.json extension/wxt.config.ts
git commit -m "feat(ext): Firefox target — gecko id, min-version 128, no-data-collection, version 0.1.0 (#107)"
```

---

## Task 2: Firefox build/zip scripts + README

**Files:**
- Modify: root `package.json`
- Modify: `extension/README.md`

- [ ] **Step 1: Add Firefox convenience scripts to the ROOT `package.json`.** In the `"scripts"` block, alongside the existing `ext:dev` / `ext:build` / `ext:test`, add:

```json
		"ext:build:firefox": "cd extension && bunx wxt build -b firefox",
		"ext:zip:firefox": "cd extension && bunx wxt zip -b firefox"
```

Keep every existing script intact. (The existing `ext:build` remains the Chromium build.)

- [ ] **Step 2: Verify the scripts run.**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107 && bun run ext:build:firefox`
Expected: builds `extension/.output/firefox-mv2/` with no error.
Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107 && bun run ext:zip:firefox`
Expected: produces a `.zip`/`.xpi` artifact under `extension/.output/` with no error. (Confirm: `ls extension/.output/*.zip extension/.output/*.xpi 2>/dev/null` shows at least one file.)

- [ ] **Step 3: Add a Firefox section to `extension/README.md`.** Insert this block immediately AFTER the existing `## Install (officers)` section and BEFORE the `## Use` section:

````markdown
## Firefox

The same codebase builds a Firefox (MV2) add-on. Firefox 128+ is required (the club-GUID
observer uses a `world: "MAIN"` content script, supported since Firefox 128).

### Dev / quick iteration (non-persistent)

```bash
cd extension
WXT_GAVELUP_URL=http://localhost:3000 bunx wxt build -b firefox   # or: bun run ext:build:firefox (prod)
```
Then open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`extension/.output/firefox-mv2/manifest.json`. Note: temporary add-ons are removed when Firefox
restarts — use the signed `.xpi` below for a lasting install.

### Persistent install (signed .xpi)

Regular-release Firefox only installs **signed** add-ons. Sign an **unlisted** build (automated
signing via Mozilla AMO — no public listing, no full review):

```bash
cd extension
bunx wxt zip -b firefox            # builds the unsigned artifact under .output/
# sign it via the AMO API (requires a Mozilla add-ons account + API credentials):
AMO_JWT_ISSUER=<your-issuer> AMO_JWT_SECRET=<your-secret> \
  bunx web-ext sign --channel=unlisted --source-dir .output/firefox-mv2
```
Install the resulting signed `.xpi` via `about:addons` → gear → **Install Add-on From File…**.
It persists across restarts. Keep the AMO credentials in your environment — never commit them.
````

- [ ] **Step 4: Add a Firefox line to the smoke-test checklist.** In `extension/README.md`, under the `## Manual smoke test (do before sharing a build)` section, append this checklist item at the end of the list:

```markdown
- [ ] Firefox: load the `firefox-mv2` build (temporary add-on or signed .xpi), then repeat the
      above (persist settings, sync on Paths Progress, bad-token error, non-basecamp-tab message).
```

- [ ] **Step 5: Commit.**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-107
git add package.json extension/README.md
git commit -m "docs(ext): Firefox build/zip scripts + install & signing docs (#107)"
```

---

## Self-review (against the spec)

- **Firefox = MV2, Chromium = MV3, one codebase** → Task 1 (WXT builds both from the same source; no code changes). ✅
- **`gecko.id` + `strict_min_version: "128.0"`** → Task 1 Step 2, verified Step 4. ✅
- **`data_collection_permissions: none` (honest)** → Task 1 Step 2, verified + warning-gone check Step 5. ✅
- **Real `version` clears "0.0.0" warning (both browsers)** → Task 1 Step 1, verified Steps 3–4. ✅
- **Chromium manifest unaffected (gecko keys Firefox-only)** → Task 1 Step 3 asserts NO `browser_specific_settings` in `chrome-mv3`. ✅
- **`ext:build:firefox` / `ext:zip:firefox` scripts** → Task 2 Steps 1–2. ✅
- **README: Firefox dev (temporary add-on) + persistent signed `.xpi` + signing command** → Task 2 Step 3. ✅
- **Firefox smoke-test checklist line** → Task 2 Step 4. ✅
- **No new automated tests (no new logic)** → correct; verification is build + manifest inspection. ✅
- **Out of scope (listed AMO, MV3-on-Firefox, Android, CI signing)** → not in any task. ✅

Placeholder scan: no TBD/TODO; every step has concrete commands/code. The one conditional is Task 1 Step 5 (adjust `data_collection_permissions` placement if WXT expects it elsewhere) — this is a deliberate, bounded verification-and-fix instruction with a clear done-condition (warning gone + declaration in manifest), not an open placeholder.

Consistency: the add-on id `pathways-sync@gavelup.app`, `strict_min_version "128.0"`, version `0.1.0`, and the `.output/firefox-mv2/` path are used identically across Tasks 1 and 2.
