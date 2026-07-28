# GavelUp Pathways Sync — browser extension (#107)

Pulls your club's Base Camp Pathways progress and pushes it to GavelUp in one click.
Built with [WXT](https://wxt.dev). Chromium (Chrome/Edge/Brave) and Firefox.

> ### Internal only — not part of the commercial product
>
> **[ADR-0025](../docs/adr/0025-no-automated-basecamp-sync-in-commercial-product.md)** (#383): this
> extension is unlisted and internal, for the maintainer's own clubs. It is **not** published to
> the Chrome Web Store, not advertised to customers, and not supported for them. Customer-facing
> Base Camp import is the manual paste at `/admin/pathways-sync`.
>
> Read the ADR before shipping this anywhere. The short version: store review is the binding
> constraint (broad host permissions on a third party's authenticated domain + user-data
> collection + transmission to a first-party server), per-user install is an onboarding cliff in
> front of a paid feature, TI's release cycle becomes our SLA, and processing member PII *on behalf
> of* clubs is a different legal role than reading your own. Using this on your own clubs is fine;
> distributing it to paying customers is a different thing and needs the decision reopened.
>
> Nothing here is deprecated — `sync_tokens`, `/api/pathways/ingest` and the `bcm_project_progress`
> mirror all stay, and are what would be reused if TI ever grants API access.

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

Regular-release Firefox only installs **signed** add-ons. Build the artifacts, then sign them
through AMO — **unlisted**, so automated signing, no public listing and no full review.

```bash
cd extension
bun run zip -b firefox
```

That writes two files under `.output/`:

| File | What it's for |
| --- | --- |
| `…-<version>-firefox.zip` | the add-on itself — this is what you upload |
| `…-<version>-sources.zip` | AMO requires source for bundler-built add-ons |

**Web upload (what you want almost always).** [addons.mozilla.org](https://addons.mozilla.org) →
Developer Hub → **Manage My Submissions** → the add-on → **Upload New Version** → pick the
`-firefox.zip`, and supply the `-sources.zip` when asked for source code. AMO signs it; download
the signed `.xpi` and install via `about:addons` → gear → **Install Add-on From File…**. No API
credentials involved.

**CLI signing** is only worth it for automation:

```bash
AMO_JWT_ISSUER=<your-issuer> AMO_JWT_SECRET=<your-secret> \
  bunx web-ext sign --channel=unlisted --source-dir .output/firefox-mv2
```
Keep the credentials in your environment — never commit them.

Either way: **bump `version` in `extension/package.json` first.** AMO rejects a version it has
already seen, and the installed add-on won't pick up changes to `matches` / `host_permissions`
until it is genuinely reinstalled — a temporary add-on is dropped on restart. Leave the gecko
`id` alone; it identifies the existing listing.

## Use

1. In Base Camp, open **Base Camp Manager → your club → Paths Progress**.
   TI serves this from `apps.basecamp.toastmasters.org` (plural). All three known
   Base Camp hosts are supported — see `lib/basecamp-hosts.ts`; that one list
   feeds both content scripts and `host_permissions`, so there is nowhere for a
   host to be half-added.
2. Click **Sync to GavelUp** in the widget (bottom-right of the page).

**No widget?** The content script only injects on the hosts in that list. Check the
page's host against it before debugging anything else — a missing host produces no
button and no error, which looks identical to the extension not being installed.
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
