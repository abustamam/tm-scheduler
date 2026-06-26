# Plan 005: Add a CI workflow that runs lint, typecheck, and tests on every push/PR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `ls .github/workflows 2>/dev/null` — if a workflow
> already exists, read it and reconcile rather than overwriting.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but most valuable after plan 001 adds real tests)
- **Category**: dx
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/15

## Why this matters

There is no CI. Nothing runs Biome, the type-checker, or the test suite when code
is pushed, so a broken build or a failing test only surfaces locally — and this
repo is explicitly set up for *agents* to execute handoff plans, where an
automated green/red signal is the safety net. A small GitHub Actions workflow
running the repo's existing gates (`bun run check`, `tsc --noEmit`, `bun run test`)
gives every push and PR a verdict.

## Current state

- No `.github/` directory exists.
- Package manager is **Bun** (`README.md:14-15`, `CLAUDE.md`). Scripts available
  (`package.json`): `check` (Biome), `test` (Vitest), `build`. There is no
  dedicated typecheck script — `bunx tsc --noEmit` is the documented way
  (`README.md:67-68`).
- The test suite is DB-independent for the unit tests (plan 001) but the
  integration tests (plan 002) need a Postgres service. To keep CI green and
  fast regardless of plan order, this workflow runs **lint + typecheck + the
  full `bun run test`**; if plan 002's integration tests are present and gated on
  `TEST_DATABASE_URL`, add the Postgres service (Step 2).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Lint/fmt  | `bun run check`      | exit 0              |
| Typecheck | `bunx tsc --noEmit`  | exit 0              |
| Test      | `bun run test`       | exit 0              |
| Validate  | `bunx --bun yaml-lint .github/workflows/ci.yml` *(optional)* | exit 0 |

## Scope

**In scope** (create):
- `.github/workflows/ci.yml`

**Out of scope** (do NOT touch):
- Any source code, scripts in `package.json`, or Biome/TS config. If a gate
  fails in CI because the code is actually broken, that's a separate finding —
  report it, don't "fix" it inside this plan.
- Deployment/CD (the Hetzner deploy is manual per ADR-0003) — this is CI only.

## Git workflow

- Branch: `advisor/005-ci-workflow`
- Conventional commit, e.g. `ci: run lint, typecheck, and tests on push/PR`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create the workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Lint & format
        run: bun run check
      - name: Typecheck
        run: bunx tsc --noEmit
      - name: Test
        run: bun run test
```

**Verify locally** (the CI steps mirror local commands):
`bun run check && bunx tsc --noEmit && bun run test` → all exit 0. If any fail
because of pre-existing issues, STOP and report (do not fix here).

### Step 2 (only if plan 002's integration tests exist): add a Postgres service

If `src/server/*.integration.test.ts` exists and reads `TEST_DATABASE_URL`, add a
Postgres service to the `check` job and push the schema before tests:

```yaml
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: tm_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
    env:
      TEST_DATABASE_URL: postgresql://test:test@localhost:5432/tm_test
```

and add a step before "Test": `- run: DATABASE_URL=$TEST_DATABASE_URL bunx drizzle-kit push`.

If those integration tests do NOT exist yet, skip Step 2 entirely.

**Verify**: re-read the final YAML; confirm indentation is valid (2-space, no
tabs — YAML requires spaces).

## Test plan

- No code tests. Validation is that the listed commands pass locally and the YAML
  is well-formed. (Actual CI execution happens once pushed, which is out of scope
  unless the operator pushes.)

## Done criteria

ALL must hold:

- [ ] `.github/workflows/ci.yml` exists and is valid YAML (2-space indent)
- [ ] Running the job's commands locally
      (`bun run check && bunx tsc --noEmit && bun run test`) all exit 0
- [ ] Step 2's Postgres service is present **iff** integration tests exist
- [ ] No source files modified (`git status` shows only the new workflow)
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report (do not improvise) if:
- Any of `bun run check` / `tsc --noEmit` / `bun run test` fails on the current
  code — that's a pre-existing problem to report, not to fix in a CI plan.
- A `.github/workflows/` file already exists — reconcile with it instead of
  overwriting.

## Maintenance notes

- When plan 002 lands, ensure Step 2's Postgres service is added so integration
  tests run in CI (otherwise they're skipped/failed depending on how the suite
  handles a missing `TEST_DATABASE_URL`).
- `bun install --frozen-lockfile` requires `bun.lock`/`bun.lockb` to be committed
  and current; if CI fails on lockfile drift, run `bun install` and commit the
  lockfile (separate change).
- Reviewer should confirm the workflow doesn't leak secrets and only runs
  read-only gates.
