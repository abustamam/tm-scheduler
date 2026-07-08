# Plan 018: Put the browser extension under CI (typecheck, tests, build)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6a37548..HEAD -- .github/workflows/ci.yml extension/package.json extension/vitest.config.ts extension/wxt.config.ts extension/tsconfig.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `6a37548`, 2026-07-08
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/129

## Why this matters

`extension/` is the WXT browser extension that syncs Base Camp Pathways
progress into the app — the only client of the security-relevant
`/api/pathways/ingest` endpoint. It has its own package (`extension/bun.lock`,
`tsconfig.json`, `vitest.config.ts`) with `test` and `build` scripts and real
unit tests (`extension/lib/basecamp-walk.test.ts`,
`basecamp-detail-walk.test.ts`) — but **no CI job runs any of it**. The root
job's `bunx tsc --noEmit` uses the root tsconfig, which excludes `extension/`.
A change can break the extension's typecheck, tests, or build on `main` with
zero signal; regressions surface only when someone manually runs
`bun run ext:*`.

## Current state

- `.github/workflows/ci.yml` (54 lines) — a single `check` job: checkout →
  `oven-sh/setup-bun@v2` → `bun install --frozen-lockfile` → biome → tsc →
  migration checks → tests (with a postgres service) → build. Nothing touches
  `extension/`.
- `extension/package.json`:

```json
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
```

- `extension/vitest.config.ts` — node environment, includes `lib/**/*.test.ts`.
- **Known gotcha (from prior work on #119)**: `wxt prepare` must have run
  before `tsc` — it generates `.wxt/` types that `extension/tsconfig.json`
  extends. The package's own `postinstall` runs it, but do not rely on
  lifecycle-script behavior in CI: run `bunx wxt prepare` explicitly.
- `extension/wxt.config.ts` reads `process.env.WXT_GAVELUP_URL` at build time;
  unset → production default `https://gavelup.app`. A CI build with it unset
  is the correct production-shaped build.
- Root `package.json` has passthrough scripts (`ext:build`, `ext:test`, …)
  that `cd extension && …` — CI can use `working-directory` instead; either
  is fine, but working-directory keeps the job self-describing.

## Commands you will need

| Purpose   | Command (from `extension/`) | Expected on success |
|-----------|------------------------------|---------------------|
| Install   | `bun install --frozen-lockfile` | exit 0 |
| Generate WXT types | `bunx wxt prepare` | exit 0, `.wxt/` exists |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Tests     | `bun run test` | all pass |
| Build     | `bun run build` | exit 0, `.output/` created |

## Scope

**In scope** (the only file you should modify):

- `.github/workflows/ci.yml`

**Out of scope** (do NOT touch):

- Anything under `extension/` — this plan only wires CI around what exists.
  (If typecheck/test/build FAIL in the new job, that's a STOP, not a license
  to fix extension code.)
- Adding a linter/formatter to the extension (real gap, separately tracked in
  the audit's small-cleanups bundle — do not fold it in here).
- The root job's steps.

## Git workflow

- Branch: `advisor/018-extension-ci` (dedicated git worktree — repo rule).
- Commit style: `ci: extension job — wxt prepare, typecheck, tests, build`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add an `extension` job to ci.yml

Append a second job (parallel to `check`, no `needs:`) to
`.github/workflows/ci.yml`:

```yaml
  extension:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: extension
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      # wxt prepare generates the .wxt/ types the tsconfig extends; run it
      # explicitly rather than relying on postinstall lifecycle behavior.
      - name: Generate WXT types
        run: bunx wxt prepare
      - name: Typecheck
        run: bunx tsc --noEmit
      - name: Test
        run: bun run test
      # WXT_GAVELUP_URL unset → production default (https://gavelup.app),
      # which is the shape that ships.
      - name: Build
        run: bun run build
```

Match the existing file's style: same action versions as the `check` job
(`actions/checkout@v5`, `oven-sh/setup-bun@v2` / `bun-version: latest`),
2-space YAML indentation.

**Verify**: `git diff .github/workflows/ci.yml` — one new top-level job under
`jobs:`; the `check` job is byte-identical to before.

### Step 2: Prove the sequence locally

From a clean state, run the five commands from the table above inside
`extension/` (a fresh worktree mimics CI best: `bun install --frozen-lockfile`
→ `bunx wxt prepare` → `bunx tsc --noEmit` → `bun run test` → `bun run build`).
All must exit 0.

**Verify**: capture each exit code in your report. Expected test output:
the two `lib/` suites pass (walk + detail-walk).

### Step 3: Hand off for a CI run

You cannot push. Report that the job needs one PR/push run to confirm on
GitHub's runners.

## Test plan

The CI job is the deliverable; the local Step 2 sequence is its rehearsal. No
new test files.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` has an `extension` job with, in order: install (frozen lockfile), `wxt prepare`, `tsc --noEmit`, `bun run test`, `bun run build`, all under `working-directory: extension`
- [ ] Locally, that exact sequence exits 0 at every step
- [ ] The existing `check` job is unchanged (`git diff` shows additions only)
- [ ] No files outside `.github/workflows/ci.yml` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Any of the five local commands fails — the extension has a latent breakage;
  report the output instead of fixing extension code (out of scope).
- `bun install --frozen-lockfile` fails inside `extension/` (lockfile drift —
  needs the operator to regenerate `extension/bun.lock` deliberately).
- `wxt prepare` requires network access to fetch browser metadata AND the
  failure persists on retry (report — may need a cached/CI-friendly flag).

## Maintenance notes

- When plan 019 (dependency pinning) or any WXT upgrade lands, this job is
  what catches extension toolchain breakage — keep it green, don't
  `continue-on-error` it.
- Follow-up candidates deliberately not included: Biome coverage for
  `extension/` (no linter there today), and tests for
  `extension/entrypoints/background.ts` (the ingest client's error mapping) —
  both are in the audit's small-cleanups list.
- If the extension gains env-dependent builds (e.g. staging), pin
  `WXT_GAVELUP_URL` explicitly in the job rather than relying on the default.
