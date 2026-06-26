# Plan 011: Make the Biome gate (`bun run check`) pass on a clean tree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `bunx biome --version` and `grep '"\$schema"' biome.json`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/004-remove-dead-scaffold-code.md (deletes `header-user.tsx`, one of the offending files — avoid fixing a file that's about to be removed)
- **Category**: dx
- **Planned at**: commit `0e33f82`, 2026-06-26 (finding discovered during execution of Wave 1)
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/18

## Why this matters

`bun run check` (Biome) **fails on a clean checkout** — 24 errors, 11 warnings —
so the repo has no working lint/format gate today. This was missed in the
original audit (recon did not run `check`) and surfaced when the CI plan (005)
executor correctly refused to add a workflow that would be red on first push.
Until this is fixed: CI (plan 005) can't go green, and every contributor/agent
gets a wall of pre-existing noise that hides their own mistakes. The failures
are almost entirely auto-fixable formatting/lint drift in starter-generated
files that were never run through Biome.

## Current state (evidence, captured at execution time)

- Installed Biome: **2.4.5**. `biome.json` declares
  `"$schema": "https://biomejs.dev/schemas/2.2.4/schema.json"` — version
  mismatch; Biome suggests `biome migrate`.
- Lint errors (FIXABLE):
  - `lint/style/useImportType` — `src/components/ui/{badge,button,card,input,label}.tsx:1`
    (`import * as React` should be `import type * as React`).
  - `lint/style/noNonNullAssertion` — `src/db/index.ts:5`
    (`process.env.DATABASE_URL!`).
- Format errors: imports not sorted / tab-vs-space indentation across
  `src/components/ui/*`, `src/components/ui/sonner.tsx`, `src/db/index.ts`,
  `src/integrations/tanstack-query/{devtools,root-provider}.tsx`.
- `src/integrations/better-auth/header-user.tsx` also errors
  (`lint/a11y/useButtonType`) — but **plan 004 deletes that file**, which is why
  this plan depends on 004.
- Totals: `Found 24 errors. Found 11 warnings.`

Conventions: Biome formats with **tabs** and **double quotes**, import
organization on (`biome.json`). `src/routeTree.gen.ts` and `src/styles.css` are
excluded. The fixes here must produce exactly what Biome's own formatter wants —
so prefer `biome` autofix over hand-edits.

## Commands you will need

| Purpose        | Command                          | Expected on success |
|----------------|----------------------------------|---------------------|
| Biome version  | `bunx biome --version`           | 2.4.5               |
| Autofix safe   | `bunx biome check --write src`   | rewrites files      |
| Autofix unsafe | `bunx biome check --write --unsafe src` | (only if needed; see Step 3) |
| Gate           | `bun run check`                  | exit 0              |
| Typecheck      | `bunx tsc --noEmit`              | exit 0              |
| Build          | `bun run build`                  | exit 0              |

## Scope

**In scope** (modify):
- `biome.json` — fix the `$schema` version to match installed Biome (2.4.5).
- `src/components/ui/*.tsx`, `src/db/index.ts`,
  `src/integrations/tanstack-query/*.tsx`, and any other file Biome flags — but
  **only formatting/lint autofixes**, no behavior changes.

**Out of scope** (do NOT touch):
- `src/routeTree.gen.ts`, `src/styles.css` — Biome-excluded; never hand-edit.
- `src/integrations/better-auth/header-user.tsx` — deleted by plan 004; if it
  still exists in your tree, that means 004 hasn't landed — STOP (see deps).
- Any logic change. If making the gate pass would require changing runtime
  behavior (beyond an import-type or a justified ignore), STOP and report.
- The Biome rule set in `biome.json` — do not disable rules wholesale to make
  errors vanish. A single targeted, commented `biome-ignore` for one genuinely
  unavoidable line is acceptable; blanket rule-disabling is not.

## Git workflow

- Branch: `advisor/011-fix-biome-gate`
- Conventional commit, e.g. `style: fix Biome lint/format gate (autofix + schema bump)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Confirm 004 has landed

`ls src/integrations/better-auth/header-user.tsx` should report **no such file**
(plan 004 deleted it). If it still exists, STOP — this plan depends on 004.

### Step 2: Fix the schema version

In `biome.json`, change the `$schema` URL from `.../2.2.4/schema.json` to
`.../2.4.5/schema.json` (match `bunx biome --version`). Alternatively run
`bunx biome migrate --write` and review its diff (it edits `biome.json` only).

### Step 3: Autofix formatting and safe lint

Run `bunx biome check --write src`. This fixes the formatting, import sorting,
and `useImportType` issues. Re-run `bun run check`.

If `noNonNullAssertion` on `src/db/index.ts:5` remains (it is not auto-fixed),
resolve it the minimal way that keeps behavior identical — either:
- a narrow, commented `// biome-ignore lint/style/noNonNullAssertion: env is validated at boot`
  on that line, or
- a tiny guard (`const url = process.env.DATABASE_URL; if (!url) throw ...`).

Pick the guard if it's clean; otherwise the commented ignore. Do NOT disable the
rule globally.

**Verify**: `bun run check` → exit 0; `bunx tsc --noEmit` → exit 0;
`bun run build` → exit 0.

### Step 4: Confirm no behavior changed

The diff should be formatting, import order, `import type`, the schema string,
and at most one ignore/guard line. Read it to confirm nothing substantive moved.

**Verify**: `git diff --stat` shows only the files from Scope; no `.ts(x)` logic
lines changed beyond the import-type keyword and the single db/index guard.

## Test plan

- No new tests (formatting/lint only). The gate itself is the test:
  `bun run check` exits 0 on a clean tree.

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run build` exits 0
- [ ] `biome.json` `$schema` matches the installed Biome version
- [ ] The diff contains no runtime-behavior changes (only format/import-type/schema/one guard)
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` status row for 011 updated

## STOP conditions

Stop and report (do not improvise) if:
- `header-user.tsx` still exists (plan 004 hasn't landed) — this plan depends on it.
- Making `check` pass appears to require a logic change or disabling a rule
  wholesale — report it; a green gate isn't worth changing behavior silently.
- `bunx biome check --write` changes `src/routeTree.gen.ts` or `src/styles.css`
  (they should be excluded) — STOP; the Biome `files.includes` config is wrong.

## Maintenance notes

- After this lands, plan 005 (CI) can proceed — its `bun run check` step will be
  green.
- The root cause is starter-generated files (shadcn `ui/*`, integration
  scaffolds) committed without running Biome. New shadcn components added via
  `bunx shadcn@latest add` may reintroduce the same drift — running
  `biome check --write` after adding components keeps the gate green.
- Reviewer should confirm the `db/index.ts` non-null fix preserves the
  fail-fast-on-missing-`DATABASE_URL` behavior.
