# Plan 017: Make CI execute the production migration runner (`.output/migrate.mjs`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6a37548..HEAD -- .github/workflows/ci.yml scripts/migrate.ts package.json Dockerfile`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `6a37548`, 2026-07-08
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/128

## Why this matters

Production applies migrations at container startup by running a **bundled
standalone runner**: the Dockerfile CMD is
`node .output/migrate.mjs && node .output/server/index.mjs`, where
`.output/migrate.mjs` is `scripts/migrate.ts` bundled by
`bun build … --target node` with drizzle-orm + pg inlined. CI, however,
applies migrations with a *different tool* — `drizzle-kit migrate` — and only
*builds* the bundle without ever executing it. A failure specific to the
bundled runner (a bundling regression, `./drizzle` folder resolution, pool
teardown, a drizzle-orm/migrator API change from a dependency bump) would
surface for the first time as a production deploy failure. This repo has
already had one migration-related production outage (pre-PR #49); closing
this gap is one CI step.

## Current state

- `scripts/migrate.ts` (35 lines) — the runner. Key facts: reads
  `process.env.DATABASE_URL` (exits 1 if unset); runs
  `migrate(db, { migrationsFolder: "./drizzle" })` — **cwd-relative**, so it
  must run from a directory containing `drizzle/`; on success prints
  `[migrate] migrations applied`; on failure prints `[migrate] failed:` and
  sets exit code 1.
- `package.json` scripts:
  - `"build": "NITRO_PRESET=node-server vite build && bun run build:migrate"`
  - `"build:migrate": "bun build scripts/migrate.ts --target node --outfile .output/migrate.mjs"`
- `.github/workflows/ci.yml` (54 lines) — one `check` job with a
  `postgres:17` service (user/pass/db: `test`/`test`/`tm_test`, port 5432,
  health-checked) and `TEST_DATABASE_URL=postgresql://test:test@localhost:5432/tm_test`.
  Step order today: checkout → setup-bun → `bun install --frozen-lockfile` →
  `bun run check` → `bunx tsc --noEmit` → migration-drift check
  (`drizzle-kit generate` + git-diff) → "Apply migrations"
  (`DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate`) → `bun run test` →
  "Build (client bundle + migrate runner)" (`bun run build`).
- The `tm_test` database is already fully migrated by the earlier
  "Apply migrations" step, so running the prod runner against `tm_test` would
  only exercise the no-op path. A **fresh database** is needed to exercise a
  full from-scratch apply (which is also what CI's drizzle-kit step does —
  fresh DB each run).
- The runtime image runs the mjs with **Node 22** (`node:22-slim`). The CI
  runner (ubuntu-latest) has a system Node; the closer the major, the better
  (see Step 2 note).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Validate workflow syntax locally | none reliable — rely on a PR run or `gh workflow view` | — |
| Local dry-run of the runner | `bun run build && DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_migrate_ci_probe node .output/migrate.mjs` | prints `[migrate] migrations applied`, exit 0 |

(For the local dry-run, create the scratch DB in the running `dev-postgres`
container first: `docker exec dev-postgres psql -U dev -c 'CREATE DATABASE tm_migrate_ci_probe;'`
and drop it after: `… -c 'DROP DATABASE tm_migrate_ci_probe;'`. Adjust
user/password if the container uses different credentials — check with
`docker exec dev-postgres psql -U dev -l`. Never start a new Postgres
container.)

## Scope

**In scope** (the only file you should modify):

- `.github/workflows/ci.yml`

**Out of scope** (do NOT touch):

- `scripts/migrate.ts` — the runner is correct; if it fails in CI that's a
  *finding*, not something to patch around (see STOP conditions).
- `package.json`, `Dockerfile`, `drizzle/`.
- The existing "Apply migrations" (drizzle-kit) step — keep it; it feeds the
  test suite and validates the migration *files*. The new step validates the
  *runner*.

## Git workflow

- Branch: `advisor/017-ci-prod-migrate-runner` (dedicated git worktree — repo rule).
- Commit style: `ci: exercise the bundled prod migrate runner against a fresh DB`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a fresh database for the runner

In `.github/workflows/ci.yml`, after the existing "Build (client bundle +
migrate runner)" step, add:

```yaml
      # Exercise the EXACT runner production boots (Dockerfile CMD runs
      # `node .output/migrate.mjs` before the server). The drizzle-kit step
      # above validates the migration files; this validates the bundled
      # runner itself (bundling, ./drizzle resolution, pool teardown) against
      # a fresh database, so a runner-specific failure breaks CI instead of a
      # production deploy.
      - name: Prod migrate runner (fresh DB)
        run: |
          PGPASSWORD=test psql -h localhost -U test -d tm_test -c 'CREATE DATABASE tm_migrate_runner;'
          DATABASE_URL=postgresql://test:test@localhost:5432/tm_migrate_runner node .output/migrate.mjs
          DATABASE_URL=postgresql://test:test@localhost:5432/tm_migrate_runner node .output/migrate.mjs
```

Notes:

- `psql` is preinstalled on `ubuntu-latest` runners (postgresql-client). If
  the step fails with "psql: command not found", prepend
  `sudo apt-get update && sudo apt-get install -y postgresql-client` — but
  try without first.
- The runner is invoked **twice** on purpose: first run = full apply on a
  fresh DB; second run = the no-op re-run path that every production boot
  after the first exercises. Both must exit 0.
- It must run from the repo root (default working dir) so `./drizzle`
  resolves — do not add a `working-directory`.

**Verify**: `git diff .github/workflows/ci.yml` shows exactly one new step
after the build step; YAML indentation matches the surrounding steps
(6-space step indent under `steps:`).

### Step 2 (optional but recommended): pin the Node major to the runtime image

The Dockerfile runtime is `node:22-slim`. If the workflow doesn't already pin
Node, add `actions/setup-node@v4` with `node-version: 22` **before** the new
step (after setup-bun is fine) so the runner executes under the same major it
runs in production. If ubuntu-latest's default Node is already 22.x, you may
skip this — check with a `node --version` echo in a scratch run or just add
the pin (harmless either way).

**Verify**: workflow file still parses (see Step 3).

### Step 3: Prove it locally, then in CI

1. Local proof (uses the dev container, see Commands):
   `bun run build` → exit 0, then the two `node .output/migrate.mjs` runs
   against a scratch DB → both exit 0; first prints
   `[migrate] migrations applied`. Drop the scratch DB after.
2. CI proof: the operator pushes/opens the PR; the `Prod migrate runner`
   step must pass. (You cannot push — note this handoff in your report.)

**Verify**: local run output captured in your report; `git status` shows only
`.github/workflows/ci.yml` modified.

## Test plan

The CI step IS the test. No unit tests. Local dry-run per Step 3 substitutes
until CI runs.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` contains a `Prod migrate runner (fresh DB)` step that (a) creates a fresh database, (b) runs `node .output/migrate.mjs` against it **twice**
- [ ] The step runs AFTER the `bun run build` step (the bundle must exist)
- [ ] Local dry-run: `node .output/migrate.mjs` against a fresh scratch DB exits 0 and prints `[migrate] migrations applied`; second run exits 0
- [ ] No files outside `.github/workflows/ci.yml` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The local dry-run of `.output/migrate.mjs` FAILS against a fresh DB — that
  is exactly the class of production-outage bug this plan exists to catch;
  report the error output, do not patch `scripts/migrate.ts`.
- The CI postgres service refuses `CREATE DATABASE` for the `test` user
  (would need service-config changes beyond this plan's scope).
- `ci.yml` has structurally changed since `6a37548` (steps renamed/reordered).

## Maintenance notes

- If the migration set ever grows slow, this step doubles the migration time
  in CI (drizzle-kit apply + runner apply). Acceptable now (~20 files, ~1 min
  total CI); revisit if CI time matters.
- If the Dockerfile CMD or `build:migrate` bundling changes, this step is the
  regression net — keep it aligned with whatever production actually boots.
- Future improvement (not this plan): assert the runner's *failure* path
  fails closed by pointing it at an unreachable DB and expecting non-zero.
