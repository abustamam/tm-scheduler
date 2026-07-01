# design-sync notes — GavelUp / tm-scheduler

Project: **GavelUp — Toastmasters Scheduler** → https://claude.ai/design/p/324a58bf-e4a0-4b13-ad91-43ca07ceb72f

## What this repo is (and why the sync is non-standard)

`tm-scheduler` is a **TanStack Start application**, not a published component library. The synced "design system" is its **shadcn/ui (new-york) primitives** under `src/components/ui/` (Badge, Button, Card, Dialog, Input, Label, Sheet, Toaster). There is **no `dist/` library build** — the converter runs in **synth-entry mode** (`[NO_DIST]` is expected, not an error).

## Required setup before every build / re-sync (do these first)

1. **Self-symlink so `PKG_DIR` resolves to this checkout.** The converter computes `PKG_DIR = <node-modules>/<pkg>`, but an app isn't installed into its own `node_modules`. Create:
   ```sh
   ln -sfn "$(pwd)" "<MAIN_CHECKOUT>/node_modules/tm-scheduler"
   ```
   and pass `--node-modules <MAIN_CHECKOUT>/node_modules`. (esbuild resolves the real deps from there via `nodePaths`; `#/lib/utils` resolves natively via package.json `imports`.) **Remove this symlink when done** — it's a temporary scaffold, not committed.
2. **Regenerate the compiled stylesheet** (gitignored — `cfg.cssEntry` points at it, the build fails without it). shadcn styling is Tailwind utility classes, and `src/styles.css` is uncompiled v4 source, so compile it first:
   ```sh
   bunx @tailwindcss/cli@4 -i src/styles.css -o .design-sync/compiled-styles.css
   ```
   This is the single most important step — it carries every utility class the components use **and** the `:root` token vars. The design app ships this as static CSS (no compiler at design time).
2b. **Re-apply the `@kind other` token annotations** (recurring fix — the DS source is upstream/read-only, so this is a sync post-step, not a source edit). The Tailwind CLI regen from step 2 wipes them, so run right after:
   ```sh
   node .design-sync/annotate-kind-other.mjs
   ```
   Idempotent; adds `/* @kind other */` after 9 Tailwind animation/transition tokens so Claude Design's token classifier does **not** surface them as design tokens (`--ease-in-out`, `--animate-spin`, `--default-transition-duration`, `--default-transition-timing-function`, and the `@property` internals `--tw-border-style`/`--tw-blur`/`--tw-backdrop-blur`/`--tw-duration`/`--tw-outline-style`). Placement: inline after the 4 theme declarations, after the closing `}` of the 5 `@property` blocks.
3. Stage scripts (`cp -r <skill>/… .ds-sync/`), `cd .ds-sync && npm i esbuild ts-morph @types/react playwright@1.59.0`.
4. Render check needs chromium; **playwright 1.59.0 pins cached chromium build 1217** on this machine (1.61 wants 1228 → would download). `PLAYWRIGHT_CHROMIUM_SANDBOX=0` is set in this env.

## Config gotchas

- `srcDir: "src/components/ui"` is required — without it synth-entry scans **all** of `src/` and pulls route/server/db code into a browser bundle (breaks).
- **Do NOT add a non-null `componentSrcMap` entry** (e.g. pinning Toaster's src). A non-null entry makes the `.d.ts` export set non-empty, which **skips** the src-derivation fallback that discovers the components — you'll get only the pinned one. The `null` exclusions for compound sub-parts (CardHeader, DialogContent, etc.) are fine; they're applied to the derived list and keep those parts in the bundle while removing their standalone cards.
- `tsconfig`/`docs` print "resolves outside the workspace root — skipped" when run from a **worktree** (bound is the main checkout). Harmless: `#/` resolves natively, no per-component docs. **Run from the main checkout** and that bound no longer skips them.
- `guidelinesGlob` is pinned to `[]` on purpose. The default (`docs/*.md`) matches `docs/persistence-todo.md` (an internal eng action-items doc, NOT a design guideline) once you run from the main checkout, and would ship it as a guideline. The DS has no real design-guideline docs, so we ship none. If genuine design guidelines are added later, point `guidelinesGlob` at them specifically.

## Known render warns (triaged-legitimate; a warn NOT here is new)

- `[FONT_REMOTE] "Manrope", "Fraunces"` — fonts load from a remote Google Fonts `@import` in `styles.css`. Expected; they serve at runtime. No `@font-face` ships.
- Toaster shows the **floor card** by design — it's an imperative sonner wrapper (`toast()` is not in the bundle), so it can't render a meaningful static card. Fully importable; documented in `conventions.md`.

## Preview/overlay specifics

- Dialog/Sheet use `defaultOpen` + `cfg.overrides.<Name>.cardMode: "single"` + a `viewport` so the open state renders in-card. Dialog viewport is `680x440` (≥640 `sm` breakpoint so the footer buttons sit side-by-side).
- Previews use **inline styles** for layout glue (not Tailwind utilities) because the shipped CSS is a static compiled subset — same reason `conventions.md` tells the design agent to.

## Re-sync risks (watch-list for the next run)

- **`compiled-styles.css` can go stale** if `src/styles.css` or any component's class usage changes — always regenerate it (step 2) before building, or the new classes/tokens won't ship.
- **Components are an in-repo shadcn copy**, not a versioned package — if `src/components/ui/*` is edited (new variant, new component, removed export), the synth-entry discovery and the authored previews can drift. Re-derive the component list and re-grade.
- The build assumed: Tailwind v4 CLI auto-content-detection from repo root; playwright/chromium 1217 cached locally; remote Google Fonts reachable.
- Sub-parts excluded via `componentSrcMap: null` are bundle-only (no card). If shadcn adds parts, add them to the null list or they'll appear as standalone cards.

## Templates (authored in Claude Design, version-controlled here)

Full-page compositions are authored in the Claude Design canvas (the `<x-dc>` / `<sc-if>` / `<x-import>` format), not in this repo's React source. They live **only** in the design project unless pulled down. `templates/meeting-agenda/` was pulled into the repo on 2026-07-01 so it is version-controlled and not lost:

- `MeetingAgenda.dc.html` — the printable club meeting agenda. Has a `layout` prop used as `<MeetingAgenda layout="timing" />`: **`timing`** (default, two-page detailed timing sheet), `spacious` (two-page), `editorial` and `grid` (one-page). Based on the sample PDFs in `samples/`.
- `ds-base.js` (loads the DS bundle — `base = '../..'` is relative to the file's location in the *design project*, not this repo), `image-slot.js` (the `<image-slot>` omelette scaffold web component), `support.js` (generated dc-runtime).

These are design-project artifacts; the repo copies are source-of-truth/backup and are **not** built or served by the TanStack app. A repo→project sync does **not** delete templates (reconciliation deletes only cover `components/ _preview/ tokens/ fonts/ _vendor/ guidelines/`), so they are safe in the project — the repo copy just guards against loss and keeps them under review.

## Token-classifier audit (fix #2 — the `:where(...)` custom props)

Audited every custom-property *definition* not on `:root` in `compiled-styles.css`: all are either (a) `--tw-*` Tailwind internals (utility-class plumbing + the universal `*, ::before, ::after, ::backdrop` reset block + `@property` registrations) or (b) the 54 real theme tokens under `.dark`, which are legitimate dark-mode overrides already mirrored on `:root`. **No mislocated theme token hides under a `:where()`/component selector — nothing to move to `:root`.** Re-confirm this if `src/styles.css` or the component class usage changes. (Fix #1, the 9 `@kind other` annotations, is handled by `annotate-kind-other.mjs` — see setup step 2b.)

## 2026-07-01 run (targeted, CSS-only)

Pulled `templates/meeting-agenda/` into the repo + applied both upstream fixes. The CSS change is comment-only (`@kind` annotations), so the build's `bundleSha12`, all 8 `renderHashes`, `scriptsSha`, and `auxSha` were **identical** to the uploaded state — only `styleSha` changed. Uploaded **only** `_ds_bundle.css` + `_ds_sync.json` (no re-grade, no re-upload of the bundle/components). Done in a git worktree (`design-sync/meeting-agenda-template`), not the main checkout.
