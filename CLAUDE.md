# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Guidance for Claude Code working in this repository. This file describes the ACTUAL
stack — follow it over any generic defaults.

## Git worktree isolation (required)

We run many issues in parallel. NEVER edit or commit directly in the main
checkout (on `main` or a local branch) — parallel sessions sharing one
checkout corrupt each other's work. Before any file edit or commit, create
and enter a dedicated git worktree (`git worktree add`). Exceptions:
read-only/inspection tasks, or when the human explicitly says to edit in place.

**Then bootstrap it — this is not optional:**

```bash
bun run worktree:setup "what you are building"
```

A worktree shares git history and nothing else. It starts with no
`node_modules`, no `.env.local`, no `ref/`, and no CodeLedger index — so
`db:*`, `dev` and the seed all fail, and CodeLedger silently returns empty
bundles reporting 0% recall rather than erroring. Four releases shipped from
worktrees on 2026-07-31 with CodeLedger contributing nothing for exactly that
reason. The script is idempotent, so re-run it whenever you are unsure. Pass a
task description to also get a task-scoped bundle; omit it for deps and env
only. Afterwards `git status` should be empty — if it is not, something in the
bootstrap wrote a tracked file and that is a bug worth chasing.

## Stack

- **TanStack Start** (React 19, SSR via Nitro), file-based routing under `src/routes/`.
- **Vite** is the bundler/dev server. Use it. Do NOT replace it with Bun.serve or HTML imports.
- **Drizzle ORM** on **PostgreSQL** via `drizzle-orm/node-postgres` (the `pg` driver).
  The db client is exported from `src/db/index.ts`; schema lives in `src/db/schema.ts`.
  Keep using `pg` / node-postgres — do NOT switch to Bun.sql or postgres.js.
- **Better-Auth** for authentication (`src/lib/auth.ts`), mounted at `src/routes/api/auth/$.ts`
  via the `server.handlers` pattern. **Magic-link is the only** sign-in method: `src/lib/auth.ts`
  uses the Better-Auth `magicLink` plugin with the Drizzle adapter (`drizzleAdapter(db, { provider: "pg" })`)
  and the `tanstackStartCookies` plugin — no email+password, no OAuth.
  Magic-link delivery goes through **Resend** (`src/lib/email.ts`, `src/lib/magic-link-email.ts`) when `RESEND_API_KEY` is set; with no key it falls back to logging the URL to the server console (dev). The React client is
  `src/lib/auth-client.ts` (`authClient.useSession()` / `signOut()`, see
  `src/integrations/better-auth/header-user.tsx`).
- **TanStack Query** for client data, SSR-integrated (`src/integrations/tanstack-query/`,
  wired as router context in `src/router.tsx`).
- **shadcn/ui** + **Tailwind CSS v4** (config-less, via `@tailwindcss/vite`; styles in
  `src/styles.css`). Add components with `bunx shadcn@latest add <name>` → `src/components/ui`.
  Icons from `lucide-react`.
- **Biome** for lint/format. **Vitest** for tests. **TypeScript strict.**

## Commands

Package manager is **Bun** (use `bun install`, `bun run <script>`).

- `bun run dev` — dev server on port 3000.
- `bun run check` — Biome lint + format gate. (`bun run lint` / `bun run format` individually.)
  **All three only report — none of them write.** `bun run fix` (`biome check --write`) applies
  the auto-fixable part: formatting, import organization, and lint rules that carry a safe fix. It
  does not clear everything — the ~120 `seed.ts` warnings noted below, and any rule with no safe
  fix, survive it. Reach for `fix`, not `format`: `organizeImports` is an assist action rather than
  a formatter rule, so `biome format --write` leaves those violations and the gate still fails.
  Two cautions. `fix` writes the whole tree and writes *even when it exits non-zero*, so do not run
  it mid-merge — it will reorder imports inside an unresolved conflict hunk and leave the file
  matching neither side. And do not reach for `--unsafe`: on this repo it rewrites ~90 lines across
  12 files, turning `!` into `?.` and converting fail-fast into `undefined` flowing into DB writes.
- `bun run test` — Vitest (uses Vitest, NOT `bun test`).
- `bun run db:generate` — generate Drizzle migrations from `src/db/schema.ts`.
- `bun run db:migrate` — apply migrations. Use this (NOT `db:push`) to keep the local dev DB
  (`tm_scheduler`) current: it is applied automatically as a `predev` step on `bun run dev` and by
  the `.githooks/post-merge` hook after a `git pull` that lands new migrations, so the dev DB always
  mirrors prod's migration path. Mixing in `db:push` diverges the migration-tracking table and
  breaks replay — reserve `db:push` for throwaway/test databases (e.g. syncing `tm_test`). `db:studio`
  to inspect.
- `bun run generate-routes` — regenerate `src/routeTree.gen.ts` (also runs during dev/build).
- `bun run build` — Vite build (Node server output via Nitro).
- `bun run typecheck` — `tsc --noEmit`. **This is the only thing that type-checks.** `bun run build`
  (Vite/esbuild) and `bun run test` (Vitest) transpile without type-checking, so both pass on
  type-broken code; run `bun run typecheck` before claiming a change is green. CI runs it in the
  `check` job.
- Run a single test with `bunx vitest run <path>` (or `bunx vitest <path>` to watch).

**Integration suites need a database or they silently SKIP.** Export
`TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` before `bun run test`, or ~630
tests vanish from the run and the pass count still reads green. A plain `bun run test` masks stale
assertions that CI catches. `tm_test` is push-synced, so after a schema change run
`DATABASE_URL=…tm_test bun run db:push --force` — that is the one database `db:push` is for.

**Read the lint gate with `--diagnostic-level=error`.** `src/db/seed.ts` carries ~118 pre-existing
`noNonNullAssertion` warnings, which Biome does not fail on, so the tail of a `bun run check` run is
a wall of noise and a single real error scrolls past. `bunx biome check --diagnostic-level=error` is
the readable view. Run the gate LAST, before commit, with CI's bare invocation — `biome check src/`
skips files a bare run includes.

## Test Coverage

Minimum: 60%
Target: 85%

Assessed against the diff, not the whole repo: every branch, error path and user flow the change
introduces should have a test that exercises it. `/ship`'s coverage audit reads these numbers and
gates on them.

Three coverage traps this repo has actually hit, all worth checking when a number looks fine:

- **A test can pin the wrong thing after a rename.** An assertion matching a role name by string
  (`r.who === "Toastmaster of the Day"`) stopped being unique once a second beat rendered the same
  owner, so it passed while the row it was written to protect could have been deleted. Assert on
  something that identifies the row, not just its owner.
- **A parity/agreement test cannot see a defect present on both sides.** `agenda-parity.test.ts`
  proves the printed run sheet and the projected deck agree; a bug in both derivations passes, and
  adding the failing club shape to its matrix passes too. Cross-surface comparisons need at least
  one golden-output assertion per shape ("this section must exist for this club") alongside them.
- **An empty-list guard is invisible to a result assertion.** Drizzle compiles an empty
  `inArray(col, [])` to `false`, so a `if (ids.length === 0) return []` short-circuit returns the
  same value whether it runs or not — a test asserting the RESULT passes with the guard deleted and
  cannot fail. Assert the observable the guard actually controls: that the round-trip was skipped
  (`vi.spyOn(testDb, "select")` + `not.toHaveBeenCalled()`). Same shape for any guard whose only
  effect is avoiding work. See `my-activity.integration.test.ts`.

## Environment

Local env goes in `.env.local` (loaded by `drizzle.config.ts` via dotenv and by the dev script).
Required: `DATABASE_URL` (Postgres connection string), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.

Optional (magic-link email delivery): `RESEND_API_KEY` and `EMAIL_FROM` (default `"GavelUp <noreply@gavelup.app>"`). Unset → magic-link URLs print to the server console (dev); set both in production to send via Resend.

Optional (platform superadmin): `SUPERADMIN_EMAILS` — a comma-separated, case-insensitive allowlist reconciled onto `user.is_superadmin` two-way on every sign-in (grant on add, revoke on remove). Unset/empty ⇒ nobody is a superadmin (fail closed). See ADR-0016 / #183.

**Local Postgres:** the `DATABASE_URL` (`…@localhost:5432/tm_scheduler`) is served by the already-running **`dev-postgres`** Docker container (`postgres:17`). Use it (`docker exec dev-postgres psql -U dev -d tm_scheduler …`); do NOT `docker run` a new Postgres — it collides on port 5432. (`localhost` resolves to IPv6 `::1` here, so a `/dev/tcp/localhost/5432` probe can false-negative even when the container is up — check `docker ps`.)

## Conventions

- **Import alias:** prefer `#/*` → `src/*` (e.g. `import { db } from "#/db"`). `@/*` also maps to
  `src/*` (used by shadcn's `components.json`), but `#/*` is the one declared in `package.json` imports.
- `src/routeTree.gen.ts` and `src/styles.css` are excluded from Biome — never hand-edit the route tree.
- `src/routes/__root.tsx` is the app shell (providers, devtools, `<head>`).
- API routes use the `server.handlers` pattern (see `src/routes/api/auth/$.ts`).
- Strict TS includes no-unused-locals/params — unused symbols fail the build.
- Biome formats with **tabs** and **double quotes**, with import organization on.

## Data layer

Schema is `src/db/schema.ts` — the full domain model (~31 tables): clubs,
people/members (Person vs Membership, ADR-0008), officer_terms, meetings,
role_definitions/role_slots (ADR-0005), member_availability, speeches
(ADR-0009), the Pathways model (pathways_paths, path_enrollments,
path_level_progress, pathways_projects, pathways_path_levels,
bcm_project_progress — ADR-0011), sync_tokens, activity_log, club_logos (a
club's own uploaded agenda logo, bytea, ADR-0024), and notifications
(drained by an in-process poller, ADR-0023). Better-Auth's tables live in
`src/db/auth-schema.ts`. See `CONTEXT.md` for the glossary.
The `db` client (`src/db/index.ts`) is `drizzle(process.env.DATABASE_URL!, { schema })`.
Migrations are generated to `./drizzle` (`drizzle.config.ts`); edit the schema, then
`bun run db:generate` + `bun run db:migrate` (do NOT `db:push` the dev DB — see the `db:migrate`
note above). CI fails if
`schema.ts` drifts from the committed migrations (a generate that produces a diff) and applies
migrations (not `push`) so the migration files are exercised the same way prod runs them.
`drizzle-orm` 0.45.1 has no built-in `bytea` type; `schema.ts` defines one once via `customType`
(`export const bytea`, used by `club_logos.bytes`) — reuse that export, don't redefine it.

**Server modules must keep `pg` out of the client bundle.** A `src/server/*.ts` module that
defines a `createServerFn` gets imported by client route files; the Start compiler strips the
server-fn *handlers* (and their `#/db` imports) from the client bundle, but a plain top-level
db-touching export sitting in that same module is NOT stripped and drags `#/db` → `pg` →
`Buffer` into the browser (`ReferenceError: Buffer is not defined`, which white-screens the
page). So: **server-fn modules export only `createServerFn`s and types.** Put the directly
testable db logic in a sibling `*-logic.ts` (see `members-logic.ts`, `activity-feed-logic.ts`)
that client code never imports; the wrapper's handler calls it and gets stripped. The
`server-modules.guard.test.ts` unit test enforces this — it would have caught both regressions.

## Deployment target

**Railway** (managed container PaaS) — see `docs/adr/0007-railway-managed-paas.md` (supersedes
ADR-0003). Push to `main` auto-deploys; env vars are set in the Railway dashboard; Postgres is
Railway's managed plugin (provides `DATABASE_URL`). This keeps the **single Node-server model**:
the Nitro `node-server` build (`.output/server/index.mjs`) and the `node-postgres` pool in
`src/db/index.ts` are unchanged. **Migrations apply at container startup**: `bun run build`
bundles a standalone runner (`scripts/migrate.ts` → `.output/migrate.mjs`, drizzle-orm + pg
inlined), the `drizzle/` SQL is copied into the runtime image, and the Dockerfile `CMD` runs
`node .output/migrate.mjs && node .output/server/index.mjs` so pending migrations apply before
the server serves traffic (drizzle tracks applied migrations, so reruns are no-ops; a migration
failure exits non-zero and the deploy fails closed). The runtime image is `node:22-slim` with no
Bun/drizzle-kit, which is why the runner is bundled rather than invoked via `drizzle-kit migrate`.
Do NOT adopt edge/serverless adapters (Cloudflare Workers / Convex) — the persistent process is
required for the `pg` pool and the planned in-process reminder poller (#7). The Workers + Neon
path stays a deferred future option only.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `abustamam/tm-scheduler` (managed via the `gh` CLI); external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

#### What earns an issue

File one only when it is (a) a correctness or security bug a user can actually hit, or (b) work
you would genuinely schedule. Everything else becomes a comment at the call site or a line in
`TODOS.md`, and is reported in the PR body or the session summary instead.

This exists because the default pulls the other way. `/ship` runs six reviewers whose job is to
find things, so every run surfaces more than one PR can absorb; filing each leftover finding is a
ratchet that grows the backlog by construction. One session closed 2 issues and opened 5 — of which
exactly one was a real bug. The other four were a two-line index, a debt note already recorded in a
code comment, and an edge case needing a three-step repro.

Two second-order costs make the bar higher than it looks:

- Labelling review residue `ready-for-agent` inflates the queue that implies real work, which is
  the number you actually plan against.
- A filed issue has a maintenance tail. Closing one as noise leaves any code comment that
  references it pointing at a dead number.

`TODOS.md` already states the boundary: it is for in-flight debt not worth an issue yet, and
anything outliving its branch becomes an issue. Respect that direction rather than inverting it.

### Triage labels

Canonical label vocabulary, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/domain-modeling`). See `docs/agents/domain.md`.

<!-- CODELEDGER:BEGIN -->
## CodeLedger Integration

This repo uses [CodeLedger](https://github.com/codeledgerECF/codeledger) for deterministic context selection.
CodeLedger is a **real CLI tool** — not a prompt technique. All commands must run in a real shell.
Version and license tier are **local runtime state**, not shared repo state. Check them with `codeledger --version` and `codeledger license status` on the current machine.

### How It Works — Zero Friction

CodeLedger runs **entirely in the background** via hooks. You don't need to learn any commands.
Just describe your task in plain English and start coding — CodeLedger handles the rest:

1. **You send a message** → CodeLedger automatically extracts the task intent
2. **Context is selected** → the most relevant files are scored and bundled deterministically
3. **Bundle is ready** → `.codeledger/active-bundle.md` contains ranked files with code excerpts
4. **You code normally** → CodeLedger tracks progress, drift, and recall in the background
5. **Session ends** → CodeLedger shows how well the bundle predicted the files you changed

Meaningful-task refresh is automatic in environments that honor CodeLedger hooks (for example Claude Code sessions).
Claude hooks delegate to CLI-backed handlers: `codeledger hooks claude user-prompt-submit`, `codeledger hooks claude pre-tool-use`, and `codeledger hooks claude stop`.
Repo-local ambient wrappers like `./.codeledger/bin/codex "your request"` and `./.codeledger/bin/claude "your request"` apply the same task-boundary rule before handoff in non-hook environments.
In browser/cloud agent containers, use the pinned runtime directly: `node .codeledger/bin/codeledger-standalone.cjs activate --task "<user request>"`.
If you need to trigger the hook decision directly for debugging, use `./.codeledger/bin/codeledger hooks claude user-prompt-submit --mode warn --json` with the Claude hook JSON payload on stdin.
Ambient toggles live in `.codeledger/config.json` under `ambient.auto_refresh_enabled` and `ambient.prompt_coach_enabled`.
For mid-session retrieval, call `./.codeledger/bin/codeledger broker refresh --task "<user request>" --json` first. Use the returned ranked files and bundle delta before falling back to raw shell search.
Broker responses include `retrievalContract.schema_version: "codeledger/broker-first/v1"`, and hooks/wrappers write `.codeledger/runtime/latest-broker-contract.json` as proof that raw search is only a fallback.
To inspect the current session state, use `./.codeledger/bin/codeledger broker current --json` for the current bundle/delta and `./.codeledger/bin/codeledger broker timeline --limit 10 --json` for the recent truth tail.

### CLI Resolution

Use the repo-local wrapper at `./.codeledger/bin/codeledger` when it exists.
It keeps repo-local behavior stable when versions differ and falls back to the vendored standalone runtime when needed.

```bash
# Preferred in a repo after `codeledger init`:
./.codeledger/bin/codeledger <command> [args...]

# Global shorthand (same machine, outside repo-local wrapper):
codeledger <command> [args...]

# Pinned fallback (browser/cloud/CI or debugging):
node .codeledger/bin/codeledger-standalone.cjs <command> [args...]
```

**Do NOT use `npx codeledger`** — it may resolve to a stale version from the npm registry.

### Auto-Activation (Hooks Handle This)

Hooks in `.claude/hooks.json` run automatically — you do NOT need to run activate manually.
When you send a message, the `UserPromptSubmit` hook checks whether the prompt starts or materially changes the task, then refreshes context only when needed.
It is intentionally designed to refresh for meaningful prompts like "Please make sure we have this happening in all environments" and skip follow-ups like "Yes please."

If you need to activate manually (e.g., to refine the task description):

```bash
./.codeledger/bin/codeledger refresh
./.codeledger/bin/codeledger activate --task "describe the task"
```

### Core Rules

1. **Execute via shell** — never simulate, fabricate, or approximate CodeLedger output. If a command fails, say so.
2. **Verify results** — check exit codes. Show errors to the user. Suggest `codeledger init` for missing config.
3. **`.codeledger/` is read-only** — never create/edit files there. Use CLI commands instead (`activate`, `session-progress`, `session-summary`).
4. **Read the live truth ledger lightly** — before a new turn, inspect only the latest timeline state from `.codeledger/session/timeline.md` (for example the last 20-25 entries), not the whole file.

### Mid-Session Commands

| Command | When to use |
|---------|-------------|
| `./.codeledger/bin/codeledger progress-check` | After completing a stage — see bundle coverage |
| `./.codeledger/bin/codeledger refresh` | Force a rebuild of the repo graph/index during a long session |
| `./.codeledger/bin/codeledger refine --learned "..."` | When you discover new context or task shifts |
| `./.codeledger/bin/codeledger broker refresh --task "..." --json` | First retrieval step for a new or shifted task inside the same session |
| `./.codeledger/bin/codeledger broker current --json` | Inspect the current active bundle, bundle delta, and recent timeline tail |
| `./.codeledger/bin/codeledger broker timeline --limit 10 --json` | Inspect the recent truth ledger tail without rereading the whole file |
| `./.codeledger/bin/codeledger review-coverage` | Mid-review — check which bundle files are unread |

### All Commands

`activate`, `scan`, `refresh`, `bundle`, `refine`, `progress-check`, `session-progress`, `session-summary`,
`review-coverage`, `doctor`, `verify`, `manifest`, `intent`, `checkpoint`, `setup-ci`, `vendor`, `pre-pr`, `auto-refresh`

Run `./.codeledger/bin/codeledger help` for details on any command.

**Trigger phrases:** If the user asks for a "session summary" or "how did the bundle do" — run `./.codeledger/bin/codeledger session-summary`. Do not construct the output yourself.
When writing your own final/session summary, append the output of `./.codeledger/bin/codeledger session-summary --agent-addendum` after your work summary so CodeLedger's measured recall/precision and notebook value tag along with the agent recap.
If you only need the notebook value block, run `./.codeledger/bin/codeledger notebook addendum`. For a human-inspectable view, run `./.codeledger/bin/codeledger notebook recent`.

### Hooks (Automatic)

Hooks in `.claude/hooks.json` run automatically:

- **SessionStart** — runs `ensure-session` (init-if-missing + scan-if-stale warmup)
- **UserPromptSubmit** — CLI-backed intent-aware activation refresh; skips "yes please" style follow-ups and same-task replies
- **PreToolUse** — activation preflight before mutating tools; warns locally and can block in managed mode
- **PostToolUse** — shows bundle recall/precision and a compact value receipt after git commits
- **PreCompact** — saves progress snapshot before context compaction
- **Stop** — shows final session recap with recall, precision, token savings

### Multi-Session

If `CODELEDGER_SESSION` is set, pass `--session $CODELEDGER_SESSION` to commands.
Session bundle: `.codeledger/sessions/{session-id}/active-bundle.md`.

### Panel (Claude Code Side Panel)

`.claude/launch.json` is pre-configured by `codeledger init` with the CodeLedger Panel server on port 7420.
**When the user runs `codeledger panel serve` or asks to open the panel**, call `mcp__Claude_Preview__preview_start` with `name: "CodeLedger Panel"` to open the cockpit directly in the Claude Code side panel.
Do NOT start the server manually via Bash first — let `preview_start` own the process.

<!-- CODELEDGER:END -->
## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

Repo-specific notes:
- `/ship` reads `VERSION`, `CHANGELOG.md`, and `TODOS.md` at the repo root. `VERSION` and `package.json` carry the same 4-digit `MAJOR.MINOR.PATCH.MICRO` string — `/ship` writes both; do not hand-edit one without the other.
- Issues are the canonical tracker (`abustamam/tm-scheduler` via `gh`), not `TODOS.md`. See `docs/agents/issue-tracker.md`.
- Ship from a worktree, never the main checkout — see "Git worktree isolation" above.
- Codex reviews are disabled (`gstack-config codex_reviews=disabled`) — there is no OpenAI subscription here. gstack's Claude adversarial and red-team passes still run; do not suggest installing the `codex` CLI, since it does nothing without credentials.

### Feature pipeline order

The maintainer does not write code. The spec is the artifact he steers, so weight review toward the
spec and run the diff-level review exactly once:

```
brainstorming → /grilling → writing-plans → /plan-eng-review → subagent-driven-development → /review → /ship
                                            ^^^^^^^^^^^^^^^^                                  ^^^^^^^
```

Both inserted steps exist for a specific reason:

- **`/plan-eng-review` before implementing.** `subagent-driven-development` reviews code against the
  plan, so a wrong plan propagates cleanly through every task and every review. v1.1.0.0 shipped a
  spec that said "all five GE beats" where the variant has six; it survived 24 per-task reviews and
  two full `/ship` runs. An independent read of the plan is the only step positioned to catch that.
- **`/review` once, after implementation, before `/ship`.** It is the only WHOLE-DIFF look —
  `subagent-driven-development`'s per-task reviews are scoped to one task and structurally cannot
  see a cross-task interaction, which is what that bug was. It also logs a review so `/ship`'s
  readiness dashboard reads CLEAR and `/ship` skips its own duplicate specialist pass.

**`/ship`'s review gate does not converge on a large diff.** It applies fixes, then stops and asks
for a re-run; the re-run reviews everything again and any large diff keeps producing informational
findings. Running `/review` first mostly avoids this. If it still fires and the round is
all-informational, say so and proceed — offer that rather than waiting to be asked. Fixing
informational findings is not free: one such fix in v1.1.0.0 introduced a user-visible regression
that the next round had to catch.

### Issue pipeline order

The other, more common workflow: bugs are found during a live club meeting, filed as issues from the
room, then `/triage` labels them at home and `ready-for-agent` ones run autonomously.

```
meeting → file issues → /triage → ready-for-agent → /investigate → implement → /qa → /ship
                               └→ ready-for-human → /grilling → implement → /qa → /ship
                               └→ needs-info → wait
```

**Do NOT run the feature pipeline on a single issue.** brainstorming → grilling → writing-plans →
subagent-driven-development earns its cost on a cross-surface feature; on a 30-line bug fix it is
pure overhead. Keep `/grilling` for `ready-for-human` issues, where the *shape* of the fix is the
open question rather than its location.

Two insertions, both on the agent path:

- **`/investigate` before implementing a bug.** This is the failure mode of an autonomous
  `ready-for-agent` run: given "the banner says the wrong thing", an agent patches the banner.
  #448 is the worked example — the issue itself listed "soften the banner copy" as an option, and
  the real cause was one line in a marker pass two functions away. Patching the copy would have
  looked like success while leaving a 35-minute Table Topics segment running against a 25-minute cap.
- **`/qa` after implementing, before the next meeting.** The loop's real defect is verification
  latency: a bug found at meeting N is fixed at home and confirmed at meeting N+1, with a live club
  as the only QA surface. `/qa` drives a real browser and collapses that to minutes. `/qa-only` for
  a report without fixes. Note `/browse` needs `GSTACK_CHROMIUM_NO_SANDBOX=1` here.

**`/ship` is cheap on a small diff — use it as-is.** It skips all specialists under 50 changed lines
and the Codex structured review under 200. The three-run loop described above was a 1,400-line
feature; the cost scales with the diff, not with the tool.

**Batch a meeting's findings.** Five small fixes shipped separately means five version bumps and five
PRs. Group related ones into one PR with a single PATCH or MICRO bump; `/ship` will not decide that.

Two skills worth running periodically rather than per-issue:

- **`/retro`** — `/ship` Step 20 already writes coverage and plan metrics to `~/.gstack/projects/`
  for exactly this, and nothing has ever read them. Over a few meetings' issues it shows which
  surfaces keep breaking.
- **`/improve`** — the proactive complement to meeting QA: one finds what broke, the other what is
  fragile. It produces self-contained plans for other agents to execute, which matches how work gets
  done here.
