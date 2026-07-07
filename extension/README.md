# GavelUp Pathways Sync — browser extension (#107)

Pulls your club's Base Camp Pathways progress and pushes it to GavelUp in one click.
Built with [WXT](https://wxt.dev). Chromium (Chrome/Edge/Brave) and Firefox.

## Develop

```bash
cd extension
bun install
bun run dev            # launches a dev browser with HMR, points at gavelup.app
# point at a local server instead:
WXT_GAVELUP_URL=http://localhost:3000 bun run dev
```

## Build a shareable extension

```bash
cd extension
bun run build                                   # prod → .output/chrome-mv3 (gavelup.app)
WXT_GAVELUP_URL=http://localhost:3000 bun run build   # dev build (localhost)
bun run zip                                      # distributable zip
```

## Install (officers)

_On Firefox? See the [Firefox](#firefox) section below instead._

1. Get the built `chrome-mv3` folder (or unzip the release).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, pick the folder.
3. Click the toolbar icon to open **Options**; paste your GavelUp **sync token** (GavelUp → Admin →
   Base Camp sync tokens), leave Server URL as `https://gavelup.app`, **Save**. Then sync from the
   **Sync to GavelUp** widget on your club's Base Camp Paths Progress page.

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

## Use

1. In Base Camp, open **Base Camp Manager → your club → Paths Progress**.
2. Click **Sync to GavelUp** in the widget (bottom-right of the page).
3. You'll see "Matched N · P path(s) updated · U unmatched" (plus a warning if the club
   looks different from last time).

_(The toolbar icon opens the extension's Options page for one-time token/server setup — the
sync itself happens from the in-page widget.)_

## Manual smoke test (do before sharing a build)

- [ ] Load unpacked (Chrome) / temporary add-on (Firefox) with no errors.
- [ ] Click the toolbar icon → the **Options** page opens; set token + server URL, Save.
- [ ] On Base Camp → your club → **Paths Progress**, a **Sync to GavelUp** widget appears
      (bottom-right). Click it → status shows "Syncing…" then "Matched N · … · U unmatched".
- [ ] With no token set, the widget prompts to set a token in options (⚙ opens Options).
- [ ] Off a Paths Progress page (GUID not seen), the widget says to open Paths Progress.
- [ ] Bad/revoked token → the widget shows the server's error; unreachable server → a network error.
- [ ] Firefox: repeat the above on the `firefox-mv2` build.
