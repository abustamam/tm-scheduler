# Releasing the browser extension

The club admin's import page (`/admin/import-history`, #1492) links to the
extension's store listings, so a club installs it instead of building it. Both
listings are unlisted, with auto-update. Submitting to the stores is the
maintainer's; this is the checklist.

1. Bump `version` in `extension/package.json`. If the bundle format changed, the
   versioning rules in #1497 apply first.
2. Build and zip for both browsers from `extension/`:
   - Chrome: `bun run zip`
   - Firefox: `bun run zip -- -b firefox` (or `bun run ext:zip:firefox` from the
     repo root). Firefox AMO also wants the sources zip (`wxt zip` writes it).
3. Upload each zip to its unlisted listing: the Chrome Web Store dashboard and
   addons.mozilla.org (Developer Hub; choose the unlisted channel so the store
   signs it and serves auto-updates).
4. First time only: paste each listing URL into `src/lib/extension-listings.ts`
   (`EXTENSION_LISTINGS.chrome` / `.firefox`). A `null` entry renders no link, and
   with both `null` the page says "Ask GavelUp support for the browser
   extension." Open the page to check the link.
5. Check the auto-update reached a test profile: install the previous version,
   wait for the store's update check (or force it from `chrome://extensions` /
   `about:addons`), and confirm the new version number.
6. Export from Easy-Speak with the updated extension and upload the file on the
   import page against GavelUp Demo Club to confirm the bundle is still accepted.
