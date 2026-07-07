# Pathways sync extension — in-page widget (replace the popup) — design

Date: 2026-07-07
Builds on: the extension in `docs/superpowers/specs/2026-07-06-pathways-extension-autosync-design.md`
and the Firefox target (`2026-07-07-pathways-extension-firefox-target-design.md`). Continues branch
`107-pathways-extension-autosync` (PR #119).

## Motivation

The browser-action **popup closes on any click outside it**, so an officer who is multitasking has
to babysit it to run a sync. Move the sync trigger + status into a small **injected widget on the
Base Camp page**, where the content script already runs, so it stays put. One-time token/server
setup moves to the extension's **Options page**.

## Decisions

1. **Sync happens from an in-page widget**, injected by the existing isolated-world content script,
   not a popup. It survives multitasking (lives in the page).
2. **Style isolation via Shadow DOM** — use WXT's `createShadowRootUi(ctx, …)` so Base Camp's CSS
   and ours can't interfere.
3. **Settings live on the extension Options page** (token + server URL). The widget is purely a
   "Sync + status" control.
4. **The popup is removed.** The toolbar icon instead **opens the Options page** on click
   (`action.onClicked` → `browser.runtime.openOptionsPage()`), so the icon still does something.
5. **Drop the manual GUID field.** Rely on the observed club GUID; if none seen yet, the widget
   tells the officer to open Paths Progress. (Re-add only if observation proves flaky.)
6. **Sync is a deliberate click** — no auto-sync on page load.

## Architecture / components

Reuses the existing page-walk, background POST, and message contract; the change is where the UI
lives and who orchestrates.

- **`entrypoints/basecamp.content.ts`** (modified) — still the isolated-world content script that
  remembers the observed GUID (from the MAIN-world `inject.content.ts`, unchanged) and holds the
  `walkProgressPages` call. Now it also **injects the widget** via `createShadowRootUi` and
  **orchestrates the whole sync itself**: on the widget's Sync click it walks the Base Camp pages
  (reused `walkProgressPages`), then messages the background worker `gavelup-ingest`, then renders
  the result/warn/error in the widget's shadow DOM. The old `gavelup-sync` `onMessage` listener
  (popup→content) is **removed** — there's no popup to drive it.
- **`entrypoints/options/index.html` + `entrypoints/options/main.ts`** (new) — token + server-URL
  inputs, load/save to `browser.storage.local` under the existing keys (`token`, `serverUrl`). This
  is the popup's settings logic, relocated. Default server URL still from
  `import.meta.env.WXT_GAVELUP_URL`.
- **`entrypoints/background.ts`** (modified) — keeps the `gavelup-ingest` → `POST /api/pathways/
  ingest` handler unchanged. Adds a `browser.action.onClicked` (MV3) / `browser.browserAction.
  onClicked` (MV2) listener → `browser.runtime.openOptionsPage()`. WXT's `browser` shim smooths the
  action naming; if a single API isn't available across both, guard with a feature check.
- **`entrypoints/popup/`** (removed) — `index.html` + `main.ts` deleted; no `default_popup`.
- **`lib/messages.ts`** (modified) — keep `IngestRequest`/`IngestResponse` and `SyncResultLike`;
  remove `SyncRequest`/`SyncResponse` (the popup→content messages) now that the content script
  orchestrates in-process.
- **`wxt.config.ts`** (modified only if needed) — ensure the manifest has an `action` (so the
  toolbar icon exists and `onClicked` fires) with no popup, and an options UI. WXT auto-derives
  `options_ui` from the `options` entrypoint and an `action` from config; add an explicit
  `action: {}` / `options_ui` entry only if WXT doesn't emit them once the popup entrypoint is gone.
  The `browser_specific_settings.gecko` block and host permissions are unchanged.

## Widget UI

- Small, fixed-position (bottom-right), unobtrusive, in a shadow root. A single **"Sync to
  GavelUp"** button and a status line beneath it. Collapsible/compact; must not cover Base Camp's
  own controls.
- States: **idle** → button enabled; **running** → button disabled + "Syncing…"; **done** →
  `Matched N · P path(s) updated · U unmatched` (+ a `⚠ warning` line when present); **error** →
  the error text (red).
- **No token:** the status line reads "Set your GavelUp token in the extension's options" with an
  affordance that opens the Options page (messages background → `openOptionsPage()`, since a content
  script can't call it directly).
- **No GUID observed:** "Open your club's Paths Progress page, then Sync."

## Data flow

```
Officer on Base Camp Paths Progress (widget injected, GUID observed by inject.content.ts)
  └ click "Sync to GavelUp" in the widget
       ├ content script: walkProgressPages(fetch, guid, csrftoken)   [reused]
       │     any page error → render "Sync failed on page N — retry" (nothing sent)
       └ browser.runtime.sendMessage({ type:"gavelup-ingest", guid, pages })  → background
            └ POST <serverUrl>/api/pathways/ingest  (Bearer token from storage)  [unchanged]
                 → { ...SyncResult, warning? } | { error }
  └ widget renders the result / warning / error inline (page stays; nothing to babysit)
```

## Error handling

Same conditions as before, now rendered in the widget instead of the popup:

| Condition | Widget shows |
|---|---|
| No token in storage | "Set your GavelUp token in the extension's options" (+ open-options) |
| No GUID observed | "Open your club's Paths Progress page, then Sync." |
| Base Camp page fetch fails mid-walk | "Sync failed on page N — retry." (nothing POSTed) |
| Bad/revoked token (401) / bad payload (400) | the server's error message |
| Can't reach server (network) | "Could not reach GavelUp: <reason>" |
| Unmatched members | the normal result line (`… · U unmatched`) |

## Testing

- The only real logic — the pure `walkProgressPages` — is unchanged and already unit-tested; those
  tests keep passing.
- The widget, options page, and background action wiring are browser/DOM glue: covered by an
  updated **manual smoke-test checklist** in `extension/README.md` (open Base Camp → widget appears
  → set token in options → Sync → result inline; toolbar icon opens options; bad-token error).
- No new automated tests (consistent with the extension's existing approach; MV3/MV2 e2e is out of
  scope).

## Out of scope

- Auto-sync on page load / scheduled sync (still #117 for the unattended case).
- The manual club-GUID input (dropped; re-add only if observation proves unreliable).
- Restyling to match Base Camp's visual design beyond a clean, unobtrusive widget.
- Any server-side change (the ingest endpoint and token model are unchanged).

## Note (local testing only, not a product concern)

`localhost` resolves to IPv6 `::1` on the dev machine while Vite listens on IPv4 `127.0.0.1`, so
local testing must point the extension at `http://127.0.0.1:3000` (build with
`WXT_GAVELUP_URL=http://127.0.0.1:3000` and set the same in options). Production (`https://
gavelup.app`) has no such ambiguity.
