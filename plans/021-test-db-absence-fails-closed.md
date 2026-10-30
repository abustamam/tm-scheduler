# Plan 021: A missing test database fails the run instead of skipping it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b955f240..HEAD -- src/test/setup-env.ts src/test/db.ts src/test/hydration-gate-ci.guard.test.ts scripts/setup-worktree.sh .github/workflows/ci.yml scripts/deploy-chain.guard.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (land this FIRST — every other plan's "tests pass" claim depends on it)
- **Category**: tests / dx
- **Planned at**: commit `b955f240`, 2026-10-30

## Why this matters

About a third of this repo's tests (316 files, ~4,700 `it()` calls) are
database-backed integration suites. Every one of them is wrapped in
`describe.skipIf(!hasTestDb)`, and `hasTestDb` is simply "is
`TEST_DATABASE_URL` set". That is the right behaviour on a laptop with no
Postgres. It is the wrong behaviour in CI and in a bootstrapped worktree,
where the database is supposed to exist: there, a missing URL silently turns
every write-path, authorization and migration test into a skip, and the run
reads green. The repo's own docs name this failure shape ("a gate that reads
green while skipping") as the one it fears most, and already fails closed for
the Chrome suites and the hydration job — but not for this larger class.

Three concrete gaps, all confirmed by reading the code:

1. CI's `check` job sets `TEST_DATABASE_URL` at job level, and nothing asserts
   it stays there. The parsed-workflow guard only checks the `hydration` job.
2. `bun run worktree:setup` prints `Done` and exits 0 when the test database
   could not be created. The next command the agent runs is `bun run test`,
   which then skips ~630 tests and reads green.
3. The two bundled seed entrypoints the production container runs at boot
   (`.output/seed-catalog.mjs`, `.output/seed-templates.mjs`) are never
   executed in CI; only `migrate.mjs` is. A bundling error or a silent no-op
   seed deploys as green.

After this plan: a CI run without a database fails loudly in every test file;
the workflow guard pins the `check` job's database env; `worktree:setup` exits
non-zero with a clear last line when the database is not ready; CI runs both
seed bundles twice against the fresh migrate-runner database and asserts rows.

## Current state

### Files

- `src/test/db.ts` — defines `hasTestDb` and the `testDb` client every
  integration suite uses.
- `src/test/setup-env.ts` — vitest `setupFiles` entry (runs before every test
  file, see `vitest.config.ts` → `setupFiles: ["src/test/setup-env.ts"]`).
  It already calls `applyWorktreeTestDb(process.env)`, which fills
  `TEST_DATABASE_URL` from a worktree's `.env.test.local`.
- `src/test/hydration-gate-ci.guard.test.ts` — parses `.github/workflows/ci.yml`
  with `js-yaml` and asserts the shape of the `hydration` job.
- `scripts/setup-worktree.sh` — worktree bootstrap; step 5 creates the test DB.
- `.github/workflows/ci.yml` — the `check` job: lint, typecheck, migrations,
  test, build, prod migrate runner.
- `scripts/deploy-chain.guard.test.ts` — greps the Dockerfile and package.json
  for the seed chain.

### Excerpts (as of `b955f240`)

`src/test/db.ts:22-27`:

```ts
/**
 * True only when a test database URL is configured. Integration suites gate on
 * this (`describe.skipIf(!hasTestDb)`) so a plain `vitest run` with no DB skips
 * them instead of failing. NEVER fall back to the production `DATABASE_URL`.
 */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);
```

`src/test/setup-env.ts:1-18` (the top of the file; the rest is jsdom shims):

```ts
import { applyWorktreeTestDb } from "./worktree-test-db";
// ... comment ...
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

// A worktree's own test database (#980). `bun run worktree:setup` records it in
// `.env.test.local` at the worktree root (`REPO_ROOT`, pinned by
// worktree-test-db.test.ts); an exported TEST_DATABASE_URL still wins.
applyWorktreeTestDb(process.env);
```

`src/test/hydration-gate-ci.guard.test.ts:129-132` (the only place the env
is asserted, and only for `hydration`):

```ts
	it("the hydration job runs the gate against Postgres and cannot be skipped or soft-failed", () => {
		const h = job("hydration");
		expect(h.services?.postgres).toBeDefined();
		expect(h.env?.TEST_DATABASE_URL).toEqual(expect.any(String));
```

`scripts/setup-worktree.sh:144-151` (the tail of the script; `set -euo pipefail`
is at the top):

```bash
echo "→ worktree test database"
if ! bun "$HERE/scripts/worktree-test-db.ts" ensure; then
	echo "  ! WARNING: no worktree test database. Database-backed suites will SKIP"
	echo "    unless TEST_DATABASE_URL is exported. Is the dev-postgres container up?"
fi

echo
echo "Done. Verify with: git status --porcelain   (expect no output)"
```

`.github/workflows/ci.yml:26-28` (job-level env on `check`) and `:106-117`
(the migrate-runner step, the last step of `check`):

```yaml
    env:
      TEST_DATABASE_URL: postgresql://test:test@localhost:5432/tm_test
```

```yaml
      - name: Prod migrate runner (fresh DB)
        run: |
          PGPASSWORD=test psql -h localhost -U test -d tm_test -c 'CREATE DATABASE tm_migrate_runner;'
          DATABASE_URL=postgresql://test:test@localhost:5432/tm_migrate_runner node .output/migrate.mjs
          DATABASE_URL=postgresql://test:test@localhost:5432/tm_migrate_runner node .output/migrate.mjs
```

`Dockerfile:57` (what production actually boots):

```
CMD ["sh", "-c", "node .output/migrate.mjs && node .output/seed-catalog.mjs && node .output/seed-templates.mjs && node .output/server/index.mjs"]
```

`scripts/seed-catalog.ts` logs `[seed-catalog] paths N, projects N, new level rows N`
on success and exits 1 on failure; `scripts/seed-templates.ts` is the same shape
for `meeting_templates`. Both are idempotent (upserts). The catalog seeds
`pathways_paths` (`src/db/schema.ts:3100`); the templates seed writes
`meeting_templates` rows with a NULL `club_id` (global templates).

### Conventions to match

- Guard tests parse the workflow with `js-yaml` via `createRequire`
  (see the top of `src/test/hydration-gate-ci.guard.test.ts` and
  `src/test/bun-version-pin.guard.test.ts`) so a commented-out line cannot
  satisfy them. Extend the existing file; do not add a new YAML parser.
- Shell scripts use tabs, `set -euo pipefail`, and `→` / `!` prefixed status
  lines (see the excerpt above).
- Biome: tabs, double quotes. Commit messages: conventional commits, e.g.
  `fix(ci): …`, `fix(test): …` (see `git log --oneline -20`).
- From `CODING_STANDARDS.md` ("Test coverage"): a guard must be mutated once to
  prove it can fail (`bun run mutate`). Do that for the workflow assertion in
  Step 2.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (worktree) | `bun run worktree:setup "plan 021"` | exit 0, last line `Done…` |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint gate | `bunx biome check --diagnostic-level=error` | exit 0, no errors |
| One test file | `bunx vitest run <path>` | all pass |
| Guard mutation | `bun run mutate <file> --literal <old> <new> <label> <test-path>` | prints the test going red, then restored |
| Full suite (DB) | `bun run test` (in a bootstrapped worktree) | exit 0; the summary's skipped count should be only the Chrome suites when `CHROME_PATH` is unset |

Note: on macOS the 21+ browser suites skip unless `CHROME_PATH` points at a
Playwright `chrome-headless-shell` (`docs/agents/commands.md`). That is a
separate, already fail-closed-in-CI class; this plan does not touch it.

## Files

- `src/test/setup-env.ts`
- `src/test/db.ts`
- `src/test/hydration-gate-ci.guard.test.ts`
- `scripts/setup-worktree.sh`
- `.github/workflows/ci.yml`
- `scripts/deploy-chain.guard.test.ts`
- `docs/agents/commands.md`

## Scope

**In scope** (the only files you should modify): the seven files listed under
`## Files` above.

**Out of scope** (do NOT touch, even though they look related):

- `vitest.config.ts` — the hydration exclude logic there is pinned by the same
  guard file; leave it.
- `scripts/worktree-test-db.ts` / `scripts/worktree-test-db-logic.ts` — their
  exit codes are already correct (non-zero on failure); the bug is the caller.
- `scripts/teardown-worktree.sh` and `scripts/teardown-worktree.test.ts`.
- Adding a `--reporter=json` skip ceiling to the `check` Test step. The
  hydration guard asserts that step's `run` is exactly `bun run test`; the
  setup-file throw in Step 1 covers the DB class without changing that line.
- Plan 026 also edits `scripts/setup-worktree.sh` (a different step). Land this
  plan first; 026 rebases on it.

## Git workflow

- Branch: `test-db-fails-closed-021` (no issue number; the repo's
  `<slug>-<issue>` rule applies to issues — a plan number is fine here).
  Create it as a git worktree per `CLAUDE.md` ("Git worktree isolation") and
  run `bun run worktree:setup` inside it.
- One commit per step is fine; conventional-commit messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fail every test file in CI when the database URL is absent

In `src/test/setup-env.ts`, directly AFTER the existing
`applyWorktreeTestDb(process.env);` line, add:

```ts
// CI always provisions Postgres (`.github/workflows/ci.yml` sets
// TEST_DATABASE_URL on both the `check` and `hydration` jobs). If it is
// missing there, every `describe.skipIf(!hasTestDb)` suite would skip and the
// run would read green with ~a third of the tests gone — the "gate that reads
// green while skipping" shape CODING_STANDARDS.md warns about. A throw here
// fails every file, which is the loud outcome we want. GitHub sets CI=true;
// a local run never sets it, so laptops without Postgres keep skipping.
if (process.env.CI === "true" && !process.env.TEST_DATABASE_URL) {
	throw new Error(
		"TEST_DATABASE_URL is not set but CI=true: the database-backed suites would silently skip. Set it in the workflow job's env.",
	);
}
```

In `src/test/db.ts`, extend the comment above `hasTestDb` with one sentence:
"In CI the setup file (`setup-env.ts`) throws instead, so a skip there is
impossible." Do not change the export.

**Verify**:

```bash
CI=true TEST_DATABASE_URL= bunx vitest run src/test/worktree-test-db.test.ts
```

→ exits non-zero and the output contains `TEST_DATABASE_URL is not set but CI=true`.

```bash
bunx vitest run src/test/worktree-test-db.test.ts
```

→ passes (no `CI` set locally).

### Step 2: Pin the `check` job's database env in the workflow guard

In `src/test/hydration-gate-ci.guard.test.ts`, add a new `it` inside the
existing top-level `describe` (next to the `hydration` job assertion quoted in
"Current state"):

```ts
	it("the check job runs the suite against Postgres with TEST_DATABASE_URL set at job level", () => {
		// The DB-backed suites skip on an unset TEST_DATABASE_URL. In CI that
		// skip is now a throw (src/test/setup-env.ts), but a job-level env is
		// what makes it never happen; a step-level or missing value is the hole.
		const c = job("check");
		expect(c.services?.postgres).toBeDefined();
		expect(c.env?.TEST_DATABASE_URL).toEqual(expect.any(String));
		const test = c.steps.find((s) => s.name === "Test");
		expect(test, "no Test step").toBeDefined();
		expect(test?.env ?? {}).not.toHaveProperty("TEST_DATABASE_URL");
	});
```

Use the file's existing `job()` helper and `Job`/`Step` types; if the `Job`
type lacks `services` or `env`, extend the type the same way the `hydration`
assertion already reads `h.services` and `h.env` (it does — reuse).

**Verify**: `bunx vitest run src/test/hydration-gate-ci.guard.test.ts` → all pass.

**Mutate**: prove the new assertion can fail by removing the env line from the
workflow and watching this test go red:

The env line is byte-identical on the `check` and `hydration` jobs, and
`bun run mutate` requires its literal to match exactly once, so anchor on the
comment that follows it in the `check` job only (`# Every job reads Bun's
version …`; the `hydration` job's comment reads `# Bun version: see …`):

```bash
bun run mutate .github/workflows/ci.yml --literal "      TEST_DATABASE_URL: postgresql://test:test@localhost:5432/tm_test
    steps:
      - uses: actions/checkout@v5
      # Every job reads Bun's version" "    steps:
      - uses: actions/checkout@v5
      # Every job reads Bun's version" check-env-removed src/test/hydration-gate-ci.guard.test.ts
```

→ the mutate script reports the test FAILING under the mutation and restores
the file. (If the literal still does not match exactly once, read the two
jobs and pick any line unique to `check` as the anchor; the requirement is one
red run with the `check` job's `TEST_DATABASE_URL` removed.)

### Step 3: `worktree:setup` exits non-zero when the test database is not ready

In `scripts/setup-worktree.sh`, replace the tail quoted in "Current state" with:

```bash
echo "→ worktree test database"
TEST_DB_READY=1
if ! bun "$HERE/scripts/worktree-test-db.ts" ensure; then
	TEST_DB_READY=0
	echo "  ! WARNING: no worktree test database. Database-backed suites will SKIP"
	echo "    unless TEST_DATABASE_URL is exported. Is the dev-postgres container up?"
fi

echo
if [ "$TEST_DB_READY" = 0 ]; then
	# Everything above still ran, so the worktree is usable for reading and
	# typechecking — but a green `bun run test` from here would be ~630 tests
	# short. Say so on the LAST line and in the exit code, because the next
	# command an agent runs is the test suite.
	echo "TEST DATABASE: NOT READY — fix Postgres and re-run 'bun run worktree:setup'."
	exit 3
fi
echo "Done. Verify with: git status --porcelain   (expect no output)"
```

Keep everything above that tail unchanged.

**Verify** (from inside your plan worktree, with Postgres reachable):

```bash
bun run worktree:setup "plan 021" ; echo "exit=$?"
```

→ last two lines are `Done. Verify with: …` then `exit=0`.

Then simulate an unreachable server without touching the real one:

```bash
DATABASE_URL=postgresql://nobody:nobody@127.0.0.1:1/none bash scripts/setup-worktree.sh ; echo "exit=$?"
```

→ output ends with `TEST DATABASE: NOT READY …` and `exit=3`. (The `bun install`
step still runs first; that is expected. If this command fails earlier for an
unrelated reason, e.g. `bun install` cannot reach the registry, note it and
re-run with network.)

Update the one sentence in `docs/agents/commands.md` that reads
"If setup warned it could not create the database, fix that and re-run setup."
to say the script now exits 3 with `TEST DATABASE: NOT READY` as its last line.

### Step 4: CI executes the bundled seed entrypoints against the fresh database

In `.github/workflows/ci.yml`, in the `check` job, directly after the
`Prod migrate runner (fresh DB)` step, add:

```yaml
      # The container's CMD runs migrate, then BOTH seed bundles, then the
      # server (Dockerfile). Until now CI exercised only migrate.mjs, so a seed
      # that failed to bundle, or silently seeded nothing (seed-templates.ts's
      # header describes exactly that Node-22 `import.meta.main` no-op),
      # deployed as green. Run each twice (idempotent) and count rows.
      - name: Prod seed runners (fresh DB)
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/tm_migrate_runner
        run: |
          node .output/seed-catalog.mjs
          node .output/seed-catalog.mjs
          node .output/seed-templates.mjs
          node .output/seed-templates.mjs
          paths=$(PGPASSWORD=test psql -h localhost -U test -d tm_migrate_runner -tAc 'select count(*) from pathways_paths')
          templates=$(PGPASSWORD=test psql -h localhost -U test -d tm_migrate_runner -tAc 'select count(*) from meeting_templates where club_id is null')
          echo "pathways_paths=$paths global meeting_templates=$templates"
          test "$paths" -gt 0 && test "$templates" -gt 0
```

Then in `scripts/deploy-chain.guard.test.ts`, add one `it` to the first
`describe` that parses `.github/workflows/ci.yml` (reuse the `js-yaml`
`createRequire` pattern from `src/test/bun-version-pin.guard.test.ts`) and
asserts the `check` job has a step whose `run` contains both
`node .output/seed-catalog.mjs` and `node .output/seed-templates.mjs` and a
`test "$paths" -gt 0` line. Name it
`"CI runs both seed bundles against the fresh migrate-runner database"`.

**Verify**:

- `bunx vitest run scripts/deploy-chain.guard.test.ts` → all pass.
- `bunx vitest run src/test/hydration-gate-ci.guard.test.ts src/test/bun-version-pin.guard.test.ts` → all pass (the workflow is still well-formed YAML and no other assertion broke).
- Mutate once: `bun run mutate .github/workflows/ci.yml --literal "          node .output/seed-templates.mjs
          node .output/seed-templates.mjs" "          true" seeds-removed scripts/deploy-chain.guard.test.ts` → red under mutation, restored.

### Step 5: Full gate

```bash
bun run typecheck && bunx biome check --diagnostic-level=error && bun run test
```

→ all three exit 0. Read the vitest summary: the skipped count must be
explainable by Chrome-only suites (if `CHROME_PATH` is unset) and nothing else.

## Test plan

- New: the `it` in `hydration-gate-ci.guard.test.ts` (Step 2) and the `it` in
  `deploy-chain.guard.test.ts` (Step 4), each mutated once.
- The setup-file throw is verified by the `CI=true TEST_DATABASE_URL=` command
  in Step 1 (a negative run, recorded in the PR body as the output line).
- Pattern to model: `src/test/hydration-gate-ci.guard.test.ts` (workflow
  parsing) and `scripts/deploy-chain.guard.test.ts` (deploy chain).

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bunx biome check --diagnostic-level=error` exits 0
- [ ] `CI=true TEST_DATABASE_URL= bunx vitest run src/test/worktree-test-db.test.ts` exits non-zero with the new message
- [ ] `bunx vitest run src/test/hydration-gate-ci.guard.test.ts scripts/deploy-chain.guard.test.ts` passes, and both new assertions went red under mutation (paste the mutate output lines in the PR body)
- [ ] `DATABASE_URL=postgresql://nobody:nobody@127.0.0.1:1/none bash scripts/setup-worktree.sh` exits 3 with `TEST DATABASE: NOT READY` as the last line
- [ ] `.github/workflows/ci.yml` `check` job has the `Prod seed runners (fresh DB)` step after the migrate-runner step
- [ ] `git status --porcelain` shows only the seven in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- `setup-worktree.sh`'s `bun install --frozen-lockfile` step exits non-zero in
  your worktree (lockfile drift is a different problem; do not "fix" it here).
- The hydration guard's existing assertion that the Test step's `run` is
  exactly `bun run test` fails after your change — you edited the wrong step.
- `node .output/seed-catalog.mjs` fails against `tm_migrate_runner` for a
  reason other than a missing bundle (e.g. a schema the seed does not expect):
  that is a real deploy-chain bug to report, not patch here.
- Any step would require touching an out-of-scope file.

## Maintenance notes

- Anyone adding a job to `ci.yml` that runs `bun run test` must give it
  `TEST_DATABASE_URL` at job level, or the setup-file throw fails it. That is
  the intended behaviour; the guard in Step 2 should be extended to the new job.
- The `CI=true` check keys off GitHub's env. A different CI provider must set
  `CI=true` or the protection is silent again — note it in the workflow if the
  provider ever changes.
- Reviewer: check the mutate output is for the NEW assertion (the guard file
  has many), and that the seed step runs each bundle twice (idempotence is
  what the Dockerfile relies on).
- Deferred on purpose: a JSON-reporter skip ceiling on the `check` Test step
  (see Out of scope) — revisit if a non-DB, non-Chrome skip class appears.
