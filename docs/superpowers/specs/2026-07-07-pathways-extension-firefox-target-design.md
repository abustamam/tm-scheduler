# Pathways sync extension — Firefox target — design

Date: 2026-07-07
Builds on: `docs/superpowers/specs/2026-07-06-pathways-extension-autosync-design.md` (the
Chromium-only v1 extension, PR #119). This adds Firefox as a first-class second target.
Branch: continues `107-pathways-extension-autosync` (folded into PR #119 — the extension becomes
cross-browser before it lands, rather than chromium-only then an immediate follow-up).

## Goal

Make the WXT extension a first-class **dual-target** — Chromium (MV3) **and** Firefox (MV2) — from
one codebase, with a **persistent, signed** Firefox build officers can install on regular-release
Firefox. Motivated by the maintainer using Firefox as a daily driver; officers may be on either
browser.

## Key finding (why this is config-only, not a rewrite)

`wxt build -b firefox` already produces a working `firefox-mv2` bundle from the existing source,
and WXT correctly translates the MV3→MV2 differences:

- `background.service_worker` → `background.scripts`
- `action` → `browser_action`
- `host_permissions` merged into `permissions` (MV2)
- **the `world: "MAIN"` content script is preserved**

Firefox has supported declared `world: "MAIN"` content scripts since **Firefox 128 (July 2024)**,
including under MV2. So the main-world GUID observer (`inject.content.ts`) works on Firefox with
**no injection fallback** and **no changes** to any content script, the background worker, or the
popup. This is purely config + build tooling + docs.

## Decisions

1. **Firefox = MV2, Chromium = MV3.** WXT's default per target. Firefox fully supports MV2 and
   MAIN-world content scripts there; MV2 is simpler (event-page background) and Firefox has not
   announced MV2 removal. Revisit MV3-on-Firefox only if that changes.
2. **One codebase, two build outputs.** No per-browser source branches. `wxt build -b chrome`
   (default) and `wxt build -b firefox`. Dev server URL still driven by `WXT_GAVELUP_URL` for both.
3. **Signed, unlisted `.xpi` for persistence.** For a daily driver, a temporary add-on
   (`about:debugging`) vanishing on restart is unacceptable. We sign an **unlisted** `.xpi` via
   Mozilla AMO (automated signing, no public listing / no full review); it installs persistently
   on regular-release Firefox. Signing is a manual release step using the maintainer's AMO API
   credentials (from env, never committed).
4. **Honest data-collection declaration.** The extension persists no Base Camp tokens and sends no
   telemetry, so declare `data_collection_permissions: { required: ["none"] }` (satisfies Firefox's
   Nov-2025 requirement for new extensions truthfully).

## Config changes (`extension/wxt.config.ts`) — additive, Chromium unaffected

WXT emits `browser_specific_settings` only into the Firefox manifest, so these do not change the
`chrome-mv3` output:

- `browser_specific_settings.gecko.id = "pathways-sync@gavelup.app"` and
  `browser_specific_settings.gecko.strict_min_version = "128.0"` (guarantees MAIN-world support).
- `data_collection_permissions: { required: ["none"] }`.
- A real `version` (start `0.1.0`) in `wxt.config.ts` (or `extension/package.json`), clearing the
  current `"0.0.0"` warning for **both** browsers.
- Optionally `suppressWarnings.firefoxDataCollection` once the declaration is in place.

## Build & distribution

- Add convenience scripts to root `package.json`: `ext:build:firefox` (`cd extension && wxt build
  -b firefox`) and `ext:zip:firefox` (`cd extension && wxt zip -b firefox`); keep the existing
  Chrome `ext:build` / `ext:dev` / `ext:test`.
- Outputs: `extension/.output/chrome-mv3/` and `extension/.output/firefox-mv2/` (both gitignored).
- **Signing:** `wxt zip -b firefox` produces the unsigned `.xpi`; sign it against the AMO API
  (`web-ext sign --channel=unlisted` or `wxt submit`) with `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`
  from the maintainer's env. The resulting signed `.xpi` installs via `about:addons` and persists.
  This is documented, not automated in CI (credentials are personal).

## Docs (`extension/README.md`)

Add a Firefox section:
- **Dev / quick iteration:** `WXT_GAVELUP_URL=… bun run dev -b firefox` or load
  `.output/firefox-mv2/` via `about:debugging` → "Load Temporary Add-on" (non-persistent).
- **Persistent install:** build → sign → install the signed `.xpi` via `about:addons`.
- Note Firefox needs the gecko id + signing for a persistent install; Chromium install steps
  stay as they are.
- Add a Firefox line to the manual smoke-test checklist (same steps as Chrome: load, persist
  settings, sync on Paths Progress, bad-token error, non-basecamp-tab message).

## Testing

The only real logic (the pure page-walk) is already unit-tested and is browser-agnostic. Both
build targets are verified to compile (`chrome-mv3` + `firefox-mv2`). No new automated tests — no
new logic is introduced. Verification is: both builds succeed, the Firefox manifest carries the
gecko id + data-collection declaration + MAIN-world content script, and the README Firefox
smoke-test passes on a real Firefox against a live Base Camp session.

## Prerequisite on the maintainer

The signed-`.xpi` path needs a **Mozilla add-ons account + AMO API credentials**. It can come
later — the `about:debugging` temporary-add-on path works immediately for testing without it.

## Out of scope

- Listed / public AMO distribution (this is an internal club tool).
- MV3 for Firefox (MV2 is sufficient and simpler; revisit only if Firefox deprecates MV2).
- Firefox for Android.
- Automating AMO signing in CI (credentials are personal; manual release step).
