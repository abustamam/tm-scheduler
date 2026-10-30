# Plan 026: A worktree gets its own DEV database, so `bun run dev`, `db:migrate` and `db:push` there never touch the shared one

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b955f240..HEAD -- src/test/worktree-test-db.ts src/test/worktree-test-db.test.ts scripts/worktree-test-db-logic.ts scripts/worktree-test-db.ts scripts/worktree-test-db.integration.test.ts scripts/teardown-worktree.test.ts scripts/setup-worktree.sh scripts/teardown-worktree.sh docs/agents/commands.md docs/agents/worktrees-and-landing.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 021 edits the TAIL of
> `scripts/setup-worktree.sh`; land 021 first and rebase, then this plan's
> Step 4 edits step 5 of that script, which 021 does not touch.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — creates and drops databases; every rule the test-DB machinery already enforces (prefix, record file, refuse-to-adopt, drop-on-failure) is reused for the dev twin
- **Depends on**: plans/021-test-db-absence-fails-closed.md (same script; land first)
- **Category**: dx
- **Planned at**: commit `b955f240`, 2026-10-30

## Why this matters

`bun run worktree:setup` gives every worktree its own TEST database (#980),
but it copies the main checkout's `.env.local` verbatim, so `DATABASE_URL`
in every worktree still names the ONE shared dev database (`tm_scheduler`).
Three commands then write to it from a branch that `main` has not merged:

- `package.json` has `"predev": "bun run db:migrate"`, so `bun run dev` in a
  worktree applies that branch's migrations to the shared database.
- `bun run db:push` in a worktree (`drizzle.config.ts` reads `.env.local`)
  pushes the branch's schema straight onto it. This happened on #1239
  (2026-10-19) and again on #1277 (2026-10-21) with a brief that said not to;
  the maintainer cleaned up by hand both times, and `drizzle-kit migrate`
  prints no error when it later fails on "already exists".
- `.githooks/post-merge` deliberately SKIPS linked worktrees ("only the primary
  checkout ... migrates the shared local dev DB") — the opposite policy from
  `predev`, in the same repo.

With ~44 worktrees under `.claude/worktrees/`, two branches carrying different
migrations can both land on one database; `main` then sees journal entries it
lacks, and a branch's destructive migration runs on the maintainer's data.

After this plan: setup creates `tm_dev_wt_<branch>_<hash>` beside the test
database, migrates it, and points the worktree's `.env.local` at it; `dev`,
`db:migrate`, `db:push` and `db:seed` in that worktree hit only that
database; teardown drops it; the main checkout is untouched.

## Current state

### Files

- `src/test/worktree-test-db.ts` — pure helpers: `TEST_DB_PREFIX`
  (`tm_test_wt_`), `testDbNameFor(label)`, `isWorktreeTestDbName`,
  `withDatabase`, `formatTestDbFile`, `parseTestDbFile`, `readTestDbFile`,
  `applyWorktreeTestDb`. Imported by the vitest setup file AND by the scripts
  (relative imports, because `teardown-worktree.test.ts` copies these files
  into a fixture repo with no `#/` map).
- `scripts/worktree-test-db-logic.ts` — `baseUrl`, `withAdmin`,
  `ensureWorktreeTestDb`, `dropWorktreeTestDb`.
- `scripts/worktree-test-db.ts` — the CLI (`ensure` | `drop`); supplies root,
  label (branch), base URL and the real `db:push --force` sync.
- `scripts/setup-worktree.sh` — step 2 copies `.env.local`; step 5 calls the
  CLI's `ensure`.
- `scripts/teardown-worktree.sh` — calls the CLI's `drop`, then removes the
  worktree.
- Tests: `src/test/worktree-test-db.test.ts` (pure), `scripts/worktree-test-db.integration.test.ts`
  (real server, stubbed sync), `scripts/teardown-worktree.test.ts` (fixture
  repo running the real shell script; `COPIED` lists exactly the four files it
  copies).
- Docs: `docs/agents/commands.md` (the `db:migrate`/`predev` paragraph) and
  `docs/agents/worktrees-and-landing.md`.

### Excerpts (as of `b955f240`)

`src/test/worktree-test-db.ts:19-33,48-61,76-89`:

```ts
export const TEST_DB_FILE = ".env.test.local";
export const TEST_DB_PREFIX = "tm_test_wt_";
export const TEST_DB_MARKER =
	"# Written by `bun run worktree:setup` (#980). Dropped by `bun run worktree:teardown`.";
export const TEST_DB_URL_KEY = "TEST_DATABASE_URL";
...
export function testDbNameFor(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!slug) throw new Error(`Cannot derive a database name from "${label}"`);
	const hash = createHash("sha256").update(label).digest("hex").slice(0, 8);
	const room = PG_IDENTIFIER_MAX - TEST_DB_PREFIX.length - hash.length - 1;
	return `${TEST_DB_PREFIX}${slug.slice(0, room).replace(/_+$/, "")}_${hash}`;
}
...
export function formatTestDbFile(url: string): string {
	return `${TEST_DB_MARKER}\n${TEST_DB_URL_KEY}=${url}\n`;
}
export interface WorktreeTestDb {
	url: string;
	name: string;
}
```

`parseTestDbFile` (`:96-114`) requires line 0 to be the marker, finds the
`TEST_DATABASE_URL=` line, and returns `null` unless the name passes
`isWorktreeTestDbName`. `applyWorktreeTestDb` (`:124-133`) reads it and fills
`env.TEST_DATABASE_URL` when unset.

`scripts/worktree-test-db-logic.ts:62-125` — `ensureWorktreeTestDb(opts)`:
reads the record; refuses a `.env.test.local` not written by setup; name =
recorded or `testDbNameFor(label)`; creates the database unless recorded
(refuses to ADOPT an unrecorded existing one); runs `opts.syncSchema(url)`
and DROPS a database it just created when the sync throws; then writes the
record. `dropWorktreeTestDb(root)` (`:131-151`) drops only the recorded name
and deletes the file.

`scripts/worktree-test-db.ts:33-43,45-55`:

```ts
function dbPush(url: string): void {
	const push = spawnSync("bun", ["run", "db:push", "--force"], {
		cwd: root,
		env: { ...process.env, DATABASE_URL: url },
		encoding: "utf8",
	});
	...
async function main(cmd: string | undefined): Promise<void> {
	if (cmd === "ensure") {
		await ensureWorktreeTestDb({ root, label: label(), base: baseUrl(root), syncSchema: dbPush, log: console.log });
	} else if (cmd === "drop") {
		await dropWorktreeTestDb(root, console.log);
```

`scripts/setup-worktree.sh:67-78` (step 2):

```bash
# 2. Env. Never clobber an existing file — a worktree may be deliberately
#    pointed at a different database than the main checkout.
if [ -f "$HERE/.env.local" ]; then
	echo "→ .env.local already present, leaving it alone"
elif [ -f "$MAIN/.env.local" ]; then
	cp "$MAIN/.env.local" "$HERE/.env.local"
	echo "→ .env.local copied from the main checkout"
```

`scripts/setup-worktree.sh:131-144` (step 5's comment, then the call; plan 021
rewrites the lines after the call):

```bash
# 5. Test database (#980). Every worktree used to run its database-backed
#    suites against the one shared tm_test, ...
echo "→ worktree test database"
if ! bun "$HERE/scripts/worktree-test-db.ts" ensure; then
```

`drizzle.config.ts:4` — `config({ path: ['.env.local', '.env'] })` (dotenv does
NOT override a variable that is already exported, so `DATABASE_URL=… bun run
db:migrate` targets the exported URL).

`package.json` — `"predev": "bun run db:migrate"`, `"db:seed": "tsx --env-file=.env.local src/db/seed.ts"`.

`scripts/teardown-worktree.test.ts:35-40`:

```ts
const COPIED = [
	"scripts/teardown-worktree.sh",
	"scripts/worktree-test-db.ts",
	"scripts/worktree-test-db-logic.ts",
	"src/test/worktree-test-db.ts",
];
```

Its cases: refuses main checkout; refuses dirty; refuses a record setup did
not write (`refusing to drop anything`); refuses locked; removes a clean
worktree with no record (`no database to drop`); with a real DB, drops
exactly the recorded `tm_test_wt_…` and not `tm_test`.

### Conventions to match

- Every database name that reaches SQL is validated against a prefix pattern
  first ("Belt and braces" in `ensureWorktreeTestDb`). Keep that for the dev
  twin: a `tm_dev_wt_` pattern, never `tm_scheduler`.
- The record file is the ONLY authority for what teardown may drop.
- Relative imports inside the four `COPIED` files; no new files among them
  (the fixture test copies exactly those four).
- Shell: tabs, `set -euo pipefail`, `→` status lines. Biome: tabs, double
  quotes. Conventional commits: `feat(worktree): …`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Bootstrap worktree | `bun run worktree:setup "plan 026"` | exit 0 (after 021: `Done…`) |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint gate | `bunx biome check --diagnostic-level=error` | exit 0 |
| Pure tests | `bunx vitest run src/test/worktree-test-db.test.ts` | all pass |
| DB tests | `bunx vitest run scripts/worktree-test-db.integration.test.ts scripts/teardown-worktree.test.ts` | all pass (need `TEST_DATABASE_URL`, which a bootstrapped worktree has) |
| List databases | `psql "$TEST_DATABASE_URL" -tAc "select datname from pg_database where datname like 'tm_%'"` | names |
| Full suite | `bun run test` | exit 0 |

## Files

- `src/test/worktree-test-db.ts`
- `src/test/worktree-test-db.test.ts`
- `scripts/worktree-test-db-logic.ts`
- `scripts/worktree-test-db.ts`
- `scripts/worktree-test-db.integration.test.ts`
- `scripts/teardown-worktree.test.ts`
- `scripts/setup-worktree.sh`
- `scripts/teardown-worktree.sh`
- `docs/agents/commands.md`
- `docs/agents/worktrees-and-landing.md`

## Scope

**In scope** (the only files you should modify): the ten files above.

**Out of scope** (do NOT touch, even though they look related):

- `package.json` `predev` — stays; it now migrates the worktree's own database,
  which is correct.
- `.githooks/post-merge` — its worktree skip stays correct (the main checkout
  migrates `tm_scheduler`).
- `src/test/setup-env.ts`, `src/test/db.ts` — the test-DB side is unchanged.
- `src/db/seed.ts` — seeding the new dev database is the agent's call
  (`bun run db:seed`), printed as a hint, not run by setup (it is slow and not
  needed for tests).
- `drizzle.config.ts` — unchanged; the worktree's `.env.local` is what it reads.
- The main checkout's `.env.local` — never written by anything here.

## Git workflow

- Branch: `worktree-dev-db-026`, as a worktree, bootstrapped (yes — this plan
  improves the bootstrap it runs under; test the NEW script by running it from
  the branch, Step 5).
- Commit per step; conventional-commit messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pure helpers for the dev twin (`src/test/worktree-test-db.ts`)

Add, next to the test constants:

```ts
/** The dev database setup creates beside the test one. `bun run dev`, `db:migrate`,
 *  `db:push` and `db:seed` in the worktree target it via `.env.local`. */
export const DEV_DB_PREFIX = "tm_dev_wt_";
/** Second key in `.env.test.local`: the dev database's URL, so teardown can drop it. */
export const DEV_DB_URL_KEY = "WORKTREE_DEV_DATABASE_URL";
```

Generalise the name builder: rename the body of `testDbNameFor` into

```ts
function worktreeDbNameFor(prefix: string, label: string): string {
	// identical to today's body, with `prefix` in place of TEST_DB_PREFIX
}
export function testDbNameFor(label: string): string {
	return worktreeDbNameFor(TEST_DB_PREFIX, label);
}
export function devDbNameFor(label: string): string {
	return worktreeDbNameFor(DEV_DB_PREFIX, label);
}
export function isWorktreeDevDbName(name: string): boolean {
	return name.length <= PG_IDENTIFIER_MAX && /^tm_dev_wt_[a-z0-9_]+$/.test(name);
}
```

Extend the record format and parser, keeping backward compatibility (a file
with only the test URL still parses, so existing worktrees keep working):

```ts
export function formatTestDbFile(url: string, devUrl?: string): string {
	const dev = devUrl ? `${DEV_DB_URL_KEY}=${devUrl}\n` : "";
	return `${TEST_DB_MARKER}\n${TEST_DB_URL_KEY}=${url}\n${dev}`;
}

export interface WorktreeTestDb {
	url: string;
	name: string;
	/** Present once setup has created the dev twin. */
	dev?: { url: string; name: string };
}
```

In `parseTestDbFile`, after the existing validation of the test URL, look
for a line starting with `${DEV_DB_URL_KEY}=`; if present, parse its database
name the same way and return `null` for the WHOLE file unless
`isWorktreeDevDbName(name)` (a record naming `tm_scheduler` as the dev twin
must never be trusted by teardown). Return `{ url, name, dev }`.

`applyWorktreeTestDb` is unchanged (it reads `db.url`).

Add a pure helper the logic module will use to rewrite `.env.local`:

```ts
/**
 * `.env.local` text with its DATABASE_URL line replaced by `url` (added at the
 * end when absent). Every other line is kept byte for byte. A comment names
 * the writer so the next reader knows why this worktree's URL differs.
 */
export function withDevDatabaseUrl(envText: string, url: string): string {
	const note = "# DATABASE_URL set by `bun run worktree:setup`: this worktree's own dev database.";
	const line = `DATABASE_URL=${url}`;
	const lines = envText.split(/\r?\n/);
	const i = lines.findIndex((l) => /^\s*DATABASE_URL\s*=/.test(l));
	if (i === -1) return `${envText.replace(/\n?$/, "\n")}${note}\n${line}\n`;
	const alreadyNoted = i > 0 && lines[i - 1] === note;
	lines.splice(i, 1, ...(alreadyNoted ? [line] : [note, line]));
	return lines.join("\n");
}
```

Tests in `src/test/worktree-test-db.test.ts` (model on the existing
`describe` blocks):

- `devDbNameFor`: `tm_dev_wt_` prefix, ≤ 63 bytes, same label → same name,
  differs from `testDbNameFor(label)`.
- `isWorktreeDevDbName`: rejects `tm_scheduler`, `tm_dev_443`, `tm_test_wt_x`,
  an injection string, and an over-long name.
- `formatTestDbFile`/`parseTestDbFile`: round-trips with and without the dev
  URL; a dev line naming `tm_scheduler` makes the whole parse `null`; a file
  written by today's format (no dev line) still parses with `dev` undefined.
- `withDevDatabaseUrl`: replaces an existing line (keeping others), appends
  when absent, is idempotent (applying twice yields the same text), keeps a
  `DATABASE_URL` that appears inside a comment untouched.

**Verify**: `bunx vitest run src/test/worktree-test-db.test.ts` → all pass,
including the new cases.

### Step 2: `ensureWorktreeDevDb` and the drop (`scripts/worktree-test-db-logic.ts`)

Add, mirroring `ensureWorktreeTestDb` rule for rule:

```ts
export interface EnsureDevOptions {
	root: string;
	label: string;
	base: string;
	/** Bring the database to the current migration state (`db:migrate`). Throws on failure. */
	migrate: (url: string) => void;
	log?: (line: string) => void;
}

/**
 * The dev twin of `ensureWorktreeTestDb`: same name rule (`devDbNameFor`), same
 * record file (a second key), same refusals (adopt nothing unrecorded, drop a
 * database this run created when its migration fails). Then points the
 * worktree's `.env.local` DATABASE_URL at it. Requires the TEST record to
 * exist already (call after `ensureWorktreeTestDb`), so one file carries both.
 */
export async function ensureWorktreeDevDb(opts: EnsureDevOptions): Promise<{ name: string; url: string; created: boolean }> {
	// 1. recorded = readTestDbFile(root); throw if null (test DB must be ensured first).
	// 2. name = recorded.dev?.name ?? devDbNameFor(label); refuse unless isWorktreeDevDbName(name).
	// 3. url = withDatabase(base, name).
	// 4. withAdmin(base): create unless exists; if exists and !recorded.dev → throw "refusing to adopt".
	// 5. try opts.migrate(url) catch → drop if created, rethrow.
	// 6. writeFileSync(TEST_DB_FILE, formatTestDbFile(recorded.url, url)).
	// 7. const envPath = join(root, ".env.local"); if it exists, rewrite with withDevDatabaseUrl; else write note+line only.
	// 8. log and return.
}
```

Write the body out in full following those eight numbered lines; reuse
`withAdmin`, `withDatabase`, `readTestDbFile`, `formatTestDbFile` and the new
`withDevDatabaseUrl` / `devDbNameFor` / `isWorktreeDevDbName` from
`../src/test/worktree-test-db`.

Extend `dropWorktreeTestDb`: after dropping the test database and BEFORE
`rmSync(path)`, if `db.dev` is present, `drop database if exists "<dev.name>" with (force)`
on the same server and log `  dropped database <dev.name>`. Only a name that
passed `isWorktreeDevDbName` in the parser can reach here.

Tests in `scripts/worktree-test-db.integration.test.ts` (model on the
existing `describe.skipIf(!hasTestDb)("ensureWorktreeTestDb")` block,
including its `afterAll` that drops every name the run could have created —
extend it to drop `devDbNameFor(l)` too):

- creates the dev database and records both URLs; a second run keeps both and
  re-runs `migrate` against the same URL;
- rewrites a copied `.env.local` in `root` so its `DATABASE_URL` is the dev URL
  and other lines survive; running again leaves the file byte-identical;
- throws when no test record exists yet;
- leaves no dev record, no dev database and an untouched `.env.local` when
  `migrate` throws (then a retry creates it);
- refuses to adopt an existing unrecorded `tm_dev_wt_…` database;
- `dropWorktreeTestDb` drops both databases and removes the record.

**Verify**: `bunx vitest run scripts/worktree-test-db.integration.test.ts` →
all pass (requires the worktree's test DB from bootstrap).

### Step 3: The CLI runs both (`scripts/worktree-test-db.ts`)

Add a `dbMigrate(url)` next to `dbPush`, identical but running
`["run", "db:migrate"]` and throwing `"db:migrate failed"` on a non-zero
status (note: `drizzle-kit migrate` exits 0 on some failures — see
STOP conditions; the create-then-migrate here is on a fresh database, where it
fails loudly). In `main`, `ensure` runs `ensureWorktreeTestDb` then
`ensureWorktreeDevDb({ root, label: label(), base: baseUrl(root), migrate: dbMigrate, log: console.log })`.
`drop` is unchanged (the logic module now drops both).

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Setup and teardown scripts

In `scripts/setup-worktree.sh` step 5, change the comment and the echo so they
name both databases, and after a successful `ensure` print:

```bash
	echo "  dev database recorded in .env.local (DATABASE_URL); it is empty —"
	echo "  run 'bun run db:seed' when you need data in 'bun run dev'."
```

Keep plan 021's `TEST_DB_READY` handling intact (an `ensure` failure now
means EITHER database failed; the message already says to re-run setup).

In `scripts/teardown-worktree.sh`, change the `→ worktree test database`
echo to `→ worktree databases (test + dev)`. Nothing else: the CLI's `drop`
already handles both.

In `scripts/teardown-worktree.test.ts`, add two cases to the existing
structure (they need no new `COPIED` entries):

- with a real database: a record carrying BOTH a `tm_test_wt_…` and a
  `tm_dev_wt_…` name drops both and keeps `tm_test`;
- a record whose dev line names `tm_scheduler` is refused
  (`refusing to drop anything`) and the worktree is kept.

**Verify**: `bunx vitest run scripts/teardown-worktree.test.ts` → all pass.

### Step 5: Run the real bootstrap from the branch

From your plan worktree (which was bootstrapped by the OLD script):

```bash
bash scripts/setup-worktree.sh "plan 026 self-test"; echo "exit=$?"
grep -n "DATABASE_URL" .env.local
cat .env.test.local
psql "$TEST_DATABASE_URL" -tAc "select datname from pg_database where datname like 'tm_dev_wt_%'"
```

→ `exit=0`; `.env.local` has the note line followed by
`DATABASE_URL=…/tm_dev_wt_worktree_dev_db_026_<hash>`; `.env.test.local` has
both keys; the dev database is listed. Then prove the three commands target
it and not the shared one:

```bash
bun run db:migrate ; echo "exit=$?"
psql "$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2-)" -tAc "select count(*) from drizzle.__drizzle_migrations"
```

→ exit 0 and a count equal to the number of entries in
`drizzle/meta/_journal.json` (`grep -c '"idx"' drizzle/meta/_journal.json`).

Run setup a second time → `exit=0`, `.env.local` byte-identical
(`md5` before/after).

Finally confirm the main checkout is untouched:
`git -C "$(git rev-parse --git-common-dir)/.." status --porcelain .env.local`
→ no output (it is gitignored anyway; the point is you did not edit it —
`diff` the main checkout's `.env.local` `DATABASE_URL` line against what it
was: it must still name `tm_scheduler`).

### Step 6: Docs

- `docs/agents/commands.md`, the `db:migrate` paragraph: add that in a
  bootstrapped worktree `DATABASE_URL` names the worktree's own
  `tm_dev_wt_…` database, so `predev`, `db:migrate`, `db:push` and `db:seed`
  there cannot reach `tm_scheduler`; the main checkout is unchanged; teardown
  drops both databases.
- `docs/agents/worktrees-and-landing.md`: one sentence in the worktree
  section pointing at the same fact, and that the #1239/#1277 failure mode
  ("db:push in a worktree hit the dev DB") is closed by it.
- `CLAUDE.md` is NOT in scope; its worktree paragraph says setup "gives it
  its own test database" — still true. Note in the PR body that a one-word
  CLAUDE.md update ("test and dev databases") is for the maintainer.

### Step 7: Gate

```bash
bun run typecheck && bunx biome check --diagnostic-level=error && bun run test
```

→ all exit 0.

## Test plan

- Pure: new cases in `src/test/worktree-test-db.test.ts` (Step 1).
- Real server: new cases in `scripts/worktree-test-db.integration.test.ts`
  (Step 2) and `scripts/teardown-worktree.test.ts` (Step 4).
- End to end: Step 5's manual run, with its outputs pasted in the PR body.
- Pattern files: the three test files being extended.

## Done criteria

- [ ] `bun run typecheck` and `bunx biome check --diagnostic-level=error` exit 0
- [ ] `bunx vitest run src/test/worktree-test-db.test.ts scripts/worktree-test-db.integration.test.ts scripts/teardown-worktree.test.ts` → all pass with the new cases
- [ ] Step 5: setup from the branch creates `tm_dev_wt_…`, rewrites `.env.local`, is idempotent, and `bun run db:migrate` in the worktree reports the full journal count on the dev twin
- [ ] The main checkout's `.env.local` `DATABASE_URL` still names `tm_scheduler`
- [ ] `grep -n "tm_dev_wt_" docs/agents/commands.md` → at least one match
- [ ] `bun run test` exits 0
- [ ] `git status --porcelain` shows only the ten in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 021 has not landed and `scripts/setup-worktree.sh`'s tail differs from
  021's excerpt — rebase first.
- The "Current state" excerpts do not match.
- `scripts/teardown-worktree.test.ts` fails because the fixture cannot
  resolve an import: you added an import that is not among the four `COPIED`
  files — move the code, do not extend `COPIED`.
- `bun run db:migrate` against a freshly created empty database exits 0 but
  the migration count is short of the journal: report it (that is the silent
  drizzle-kit failure the docs describe) and do not proceed to Step 6.
- Creating the dev database needs a privilege the dev role lacks
  (`permission denied to create database`): the test twin would fail the same
  way, so report rather than work around it.
- Anything would write the main checkout's `.env.local`.

## Maintenance notes

- A worktree bootstrapped BEFORE this change has no dev twin until setup is
  re-run there; its `.env.local` still names the shared database. Say so in
  the PR body; the next `bun run worktree:setup` in each one fixes it.
- Database count per worktree is now two; `tm_dev_wt_` and `tm_test_wt_`
  names are the teardown's whole authority. Never hand-create a database with
  either prefix.
- Reviewer: check `parseTestDbFile` returns `null` for the WHOLE record when
  the dev line is untrusted (the first draft of such code tends to drop only
  the dev half), and that `withDevDatabaseUrl` is idempotent.
- Deferred on purpose: cloning the main dev database's DATA into the twin
  (`CREATE DATABASE … TEMPLATE tm_scheduler` needs no open connections to the
  template, which a running `bun run dev` in the main checkout denies);
  `bun run db:seed` is the documented way to get data.
