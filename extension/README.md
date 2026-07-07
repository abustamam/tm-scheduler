# GavelUp Pathways Sync — browser extension (#107)

Pulls your club's Base Camp Pathways progress and pushes it to GavelUp in one click.
Built with [WXT](https://wxt.dev). Chromium only (Chrome/Edge/Brave).

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

1. Get the built `chrome-mv3` folder (or unzip the release).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, pick the folder.
3. Click the extension, paste your GavelUp **sync token** (GavelUp → Admin → Base Camp sync
   tokens), leave Server URL as `https://gavelup.app`, **Save settings**.

## Use

1. In Base Camp, open **Base Camp Manager → your club → Paths Progress**.
2. Click the extension → **Sync now**.
3. You'll see "Matched N · P path(s) updated · U unmatched" (plus a warning if the club
   looks different from last time).

## Manual smoke test (do before sharing a build)

- [ ] Load unpacked with no errors on `chrome://extensions`.
- [ ] Save + reopen popup — token/server persist.
- [ ] On Paths Progress, **Sync now** succeeds and the count matches the roster.
- [ ] Bad token → popup shows "Token invalid".
- [ ] Not on a Base Camp tab → popup tells you to open Paths Progress.
- [ ] Confirm on the GavelUp Pathways screens that progress updated.
