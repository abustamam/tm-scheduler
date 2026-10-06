# CLAUDE.md

Guidance for Claude Code working in this repository. It describes the ACTUAL stack — follow it
over any generic defaults.

**This file rides in every call of every session AND every subagent, so it holds only what every
session needs** (2026-10-05, `docs/agents/token-usage.md`). The long versions of each section —
the incidents, the measurements, the history — were moved verbatim to `docs/agents/`, and each
section below names its file. Read that file when you touch the area; do not paste it back here.

## Sessions and agents cost tokens

[MEASURED 2026-09-28..29, `docs/agents/token-usage.md`] 75% of this repo's spend was subagents,
every one on Opus because no dispatch named a model, and two thirds of the spend was on calls
carrying >150k context.

- **Dispatch implementation to the `implementer` agent** (`.claude/agents/implementer.md`,
  Sonnet), searches to `explorer` (Haiku). A wave agent is an implementer. Opus is for the main
  session's judgement: specs, review, the merge decision.
- **One wave or one issue per session, then hand off.** Compact near 250k.
- **Write the handoff whenever the session stops: blocked on the maintainer, or done.** The
  maintainer cannot predict when they step away, and a session idle for over an hour has lost
  its cache. Resuming one costs a full rebuild of the context (`docs/agents/token-usage.md`), so
  the handoff is what a fresh session starts from.
  - **Only the main session writes it.** A subagent that needs a decision returns at once with the
    question as its result; its parent batches every open question into ONE handoff.
  - **Blocked on CI, a deploy or a running agent is not blocked on the maintainer.** Keep working
    or wait on it; write no handoff for it.
  - **Where:** one comment per issue or PR, EDITED in place as things change, never a new
    comment per question. Find the one whose body starts `**Handoff**` with
    `gh api repos/abustamam/tm-scheduler/issues/N/comments` and `PATCH` it by id. Do NOT use
    `--edit-last`: agents post as the maintainer's account, so it edits the maintainer's latest
    comment. A wave's goes on its
    tracking issue, else on each PR. With no issue or PR, the handoff is the session's final
    message.
  - **The repo is PUBLIC.** Write repo-relative paths, branch names and public links only. No
    local paths, env values, tokens, member data or prod rows. If the blocker itself is sensitive,
    write "needs you: see the session" and put the detail in the final message.
  - **Then notify:** a push notification when the handoff asks for something, never when it says
    "nothing". If no notification tool exists, say so in the final message and stop anyway.
  - **When the maintainer answers:** a short answer ("yes", "option B") is replied in place. An
    answer that starts real work goes to a fresh session pointed at the handoff, and that session
    first edits the handoff to record the decision.

  ```markdown
  **Handoff** (<date>)
  - **Needs you:** each decision, with options and a recommendation; or "nothing"
  - **State:** PR / branch, CI status
  - **Done:** what landed, with the real test counts or CI run link
  - **Next:** the one or two concrete steps after the decision
  - **Gotchas:** anything a fresh session would trip on
  ```
- An agent's "it passed" is not evidence: read the number (the test count, the CI run) yourself.

## Git worktree isolation (required)

We run many issues in parallel. NEVER edit or commit directly in the main checkout — parallel
sessions sharing one checkout corrupt each other's work. Before any file edit or commit, create
and enter a dedicated git worktree (`git worktree add`). Exceptions: read-only/inspection tasks,
or when the human explicitly says to edit in place. **Then bootstrap it, from inside it:**

```bash
bun run worktree:setup "what you are building"
```

A worktree starts with no `node_modules`, `.env.local`, `ref/` or CodeLedger index; setup also
gives it **its own test database** (#980). **Do not export `TEST_DATABASE_URL` in a worktree** —
an exported value wins and puts you back on the shared `tm_test`. Afterwards `git status` should
be empty. Done: **`bun run worktree:teardown`** from inside the worktree.

**Branch naming: `<slug>-<issue>`, the number LAST, nothing after it.** `fix-dialog-scroll-619`;
two issues: `worktree-convert-guard-617-618`. The name is the claim `bun run batch:issues` reads
— a prefixed number, or `-619-wip` / `-619-v2`, claims NOTHING and the issue is handed out again.
A retry needs a different slug. A thematic name claims nothing, deliberately. `EnterWorktree`
prepends `worktree-`, so `git branch -m <slug>-<issue>` right after.

Full rules and the failures behind them: `docs/agents/worktrees-and-landing.md`.

## Stack

- **TanStack Start** (React 19, SSR via Nitro), file-based routing under `src/routes/`.
- **Vite** is the bundler/dev server. Do NOT replace it with Bun.serve or HTML imports.
- **Drizzle ORM** on **PostgreSQL** via `drizzle-orm/node-postgres` (the `pg` driver). Client in
  `src/db/index.ts`, schema in `src/db/schema.ts`. Do NOT switch to Bun.sql or postgres.js.
- **Better-Auth** (`src/lib/auth.ts`, mounted at `src/routes/api/auth/$.ts`). **Magic-link is the
  only sign-in method**; the same instance is an **OAuth 2.1 authorization server** for
  `/api/mcp` (#842 / ADR-0027), which accepts `tmk_…` personal tokens and OAuth access tokens
  (#843). **`tanstackStartCookies()` must be LAST in the plugins array**; `BETTER_AUTH_URL` is
  load-bearing at import; Dynamic Client Registration stays OFF. **Read `docs/agents/auth.md`
  before touching auth, OAuth, CIMD, `/api/mcp`, `/signin` or `/oauth/consent`** — it has the
  traps, the guard tests and which file may import what. Connector runbook:
  `docs/claude-connector.md`.
- **TanStack Query** for client data, SSR-integrated (`src/integrations/tanstack-query/`).
- **shadcn/ui** + **Tailwind CSS v4** (config-less, `src/styles.css`). `bunx shadcn@latest add
  <name>` → `src/components/ui`. Icons from `lucide-react`.
- **Biome** for lint/format. **Vitest** for tests. **TypeScript strict.**

## Commands

Package manager is **Bun**. Every command's traps and history: `docs/agents/commands.md` — read
it before a migration, a browser-backed test, a mutation check or a batch plan.

- `bun run dev` — dev server on port 3000.
- `bun run check` — Biome lint + format gate; reports only. `bun run fix` writes the safe fixes
  (not `format`; never `--unsafe`; never mid-merge). Read errors with
  `bunx biome check --diagnostic-level=error` — `seed.ts` carries ~118 warnings.
- `bun run typecheck` — **the only thing that type-checks.** `build` and `test` pass on
  type-broken code; run it before claiming green.
- `bun run test` — Vitest, NOT `bun test`. One file: `bunx vitest run <path>`.
  `bun run test:hydration` — the route hydration gate alone (its own CI job).
- `bun run db:generate` then `bun run db:migrate` for the dev DB — **never `db:push` the dev
  DB**. `db:push` is for test databases only, and it does not update an existing partial index's
  `WHERE` predicate.
- `bun run generate-routes` — dev/build append a footer to the tracked `src/routeTree.gen.ts`;
  never `git add -A` after `bun run dev`. `.githooks/pre-commit` blocks it.
- `bun run batch:issues` — group `ready-for-agent` issues into file-disjoint waves; a plan, not
  an assignment. It reads the change set from a heading that is exactly `## Files`.
- `bun run mutate <file> --literal <old> <new> <label> <test-path…>` — **the** way to
  mutation-check a test. Never improvise with `sed` + `git checkout`.

**Tests that silently skip read green.** Integration suites need a database (a bootstrapped
worktree has one; in the main checkout export `TEST_DATABASE_URL=…/tm_test`, or ~630 tests
vanish). Browser-backed suites need Chrome (on macOS set `CHROME_PATH` to a Playwright
`chrome-headless-shell`; never hardcode the `.app` binary). A suite seeding a CLUB-LESS row
cleans it up itself, with per-run keys. Details: `docs/agents/commands.md`.

## Test Coverage

Minimum: 60%. Target: 85%. Assessed against the diff: every branch, error path and user flow the
change introduces needs a test. The traps a green number hides are in `CODING_STANDARDS.md`
("Test coverage"), which `/review-pr` reads.

## Environment

Local env in `.env.local`. Required: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.
Optional: `RESEND_API_KEY` + `EMAIL_FROM` (unset → magic links print to the console);
`SUPERADMIN_EMAILS` (unset ⇒ nobody, fail closed; ADR-0016).

**Local Postgres** is the already-running **`dev-postgres`** Docker container (`postgres:17`):
`docker exec dev-postgres psql -U dev -d tm_scheduler …`. Do NOT `docker run` another. Check it
with `docker ps`, not a `/dev/tcp/localhost` probe (`localhost` is `::1` here).

## Conventions

- **Import alias:** prefer `#/*` → `src/*`. `@/*` also maps (shadcn uses it).
- `src/routeTree.gen.ts` and `src/styles.css` are excluded from Biome — never hand-edit the
  route tree. `src/routes/__root.tsx` is the app shell. API routes use `server.handlers`.
- Strict TS includes no-unused-locals/params. Biome: **tabs**, **double quotes**, organized
  imports.
- Three longer rules live in `CODING_STANDARDS.md` ("Conventions"): print routes share
  `PRINT_PAGE_CSS`; no `:not()` arm or `!important` on the text-link rule; a dialog's height
  belongs to `DialogContent`.

## Data layer and deployment

Schema `src/db/schema.ts` (~39 tables; glossary in `CONTEXT.md`). Better-Auth's tables live in
`src/db/auth-schema.ts`; **a new Better Auth plugin's tables go there AND are re-exported from
`schema.ts`**, or the first request 500s. `bytea` is defined once in `schema.ts` — reuse it. The
plan and the record (attendance) are two tables. The schema's invariants are in
`CODING_STANDARDS.md` ("Data layer").

**Railway**, push to `main` auto-deploys; migrations apply at container start. Do NOT adopt
edge/serverless adapters — the `pg` pool and the in-process poller (ADR-0023) need a persistent
process. **Changing a `createServerFn`'s `method` breaks open tabs**: every caller needs a
fallback in the same change. Full sections: `docs/agents/data-and-deploy.md`.

## Agent skills

### Issue tracker

GitHub issues in `abustamam/tm-scheduler` via `gh`; see `docs/agents/issue-tracker.md`.

#### What earns an issue

An agent does not go looking for work. What it notices goes to one of three places, tested by
`git diff --name-only`:

- **Inside the files the PR touches:** fix it in the PR and name it in the body.
- **Outside the diff, and a user-visible bug, data loss or corruption, a security hole, or a
  dev-ex bug** (a defect in the repo's own tooling — a gate that reads green while skipping, a
  script that exits 0 having done nothing; label `bug`): one issue whose first line is
  `Found by an agent while working on #N`, labelled `needs-triage` plus a category. Never
  `ready-for-agent` — that label is the maintainer's.
- **Anything else:** one sentence in the PR body or the final message. No issue, no `TODOS/`
  entry, no code comment pointing at a number.

Why: `docs/agents/issue-tracker.md`.

### Triage labels

Ten labels and no others: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`, `tracking`, `bug`, `enhancement`, `migration` (run alone), `priority` (run first;
the maintainer's). **Name the consumer before adding an eleventh** (`docs/agents/triage-labels.md`).

### Domain docs

One `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

<!-- CODELEDGER:BEGIN -->
## CodeLedger Integration

[CodeLedger](https://github.com/codeledgerECF/codeledger) selects context deterministically and runs
through the hooks in `.claude/hooks.json`; nothing here needs invoking by hand. Four things worth
knowing, the rest is in `./.codeledger/bin/codeledger help` and the vendor docs:

- **Use the repo-local wrapper**, `./.codeledger/bin/codeledger <command>`. Do NOT use
  `npx codeledger`: that unscoped npm name is an unrelated package. `npx @codeledger/cli` if you
  must use npx; `node .codeledger/bin/codeledger-standalone.cjs` in a container.
- **Execute via shell, never simulate its output.** If a command fails, say so.
- **`.codeledger/` is read-only.** Use the CLI (`activate`, `refine`, `session-summary`) rather
  than editing files there.
- **Only a worktree has an index.** `bun run worktree:setup` runs `codeledger init` + `activate`;
  the main checkout has neither, so `doctor` there is misleading and bundles report 0% recall.
  If `CODELEDGER_SESSION` is set, pass `--session $CODELEDGER_SESSION`.

"Session summary" or "how did the bundle do" means run
`./.codeledger/bin/codeledger session-summary`, not write one.

<!-- CODELEDGER:END -->
## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. MVP phase, live
users, one maintainer who steers specs rather than writing code: review effort goes where it has
been shown to pay, release ceremony is zero, deferred debt is not logged. `/ship` does not run here.

| To… | Use |
|---|---|
| Shape a feature | brainstorming or `/grilling`, then **always `/spec`** → `ready-for-agent` issues citing files. `/plan-eng-review` only if `/spec` emits three or more. |
| Triage the room's issues | `/triage` |
| Plan a wave | `bun run batch:issues`, acted on per the `dispatching-issue-waves` project skill |
| Debug | `/investigate` (satisfies superpowers' systematic-debugging gate) |
| Open a PR | `gh pr create`. The agent stops there. |
| Review a PR | `/review-pr N` from the main session; gstack `/review` in the PR's worktree **as well** for a risk category (below). |
| Land | `gh pr merge --squash --auto` (needs "Allow auto-merge" ON). `gh pr update-branch N` only for a real conflict. |
| Verify a wave | `/qa-only` against the deployed app, once per wave. A finding becomes an issue only per "What earns an issue". |
| See what shipped | `/retro` (gstack); `/session-retro` for what made a session harder than it needed to be. |
| Park debt | Don't. `TODOS/` takes no new files. |

### Pull requests

- **Title**: conventional-commit style, `fix(agenda): …`. `VERSION` and `CHANGELOG.md` are
  frozen; do not bump either.
- **Body**: `Closes #N` whenever an issue exists — mandatory, or the next `batch:issues` hands
  the issue out again. Work asked for directly with no issue: `Asked for directly; no issue`.
- **A wave agent never merges its own PR.** Merging happens from the main session after
  `/review-pr`. Branch protection is `strict: false` (required checks `check`, `extension`,
  `hydration`), so watch **CI on `main`** after a wave lands — that is what catches a cross-PR
  clash.
- **Do not pass `--delete-branch`.** Remove the worktree, then the branch.
- **Verify a merge with `gh pr view N --json state,mergeCommit`**, never from `gh pr merge`'s
  output (silent under a tool call; can print `fatal` after landing).

Why each of these, and the auto-merge setting's history: `docs/agents/worktrees-and-landing.md`.

### Which review

`/review-pr` runs two axes, Standards and Spec, against the PR's branch on `origin`. Neither asks
who may now write or delete another person's record — #573 did exactly that in 81 lines with every
gate green — so for a **risk category** run gstack `/review` in the PR's worktree as well, at any
size:

- authentication or **authorization**: anything changing who may write or delete another
  person's record;
- the archive gate (`guards.ts`, `club-readable-logic.ts`, `meeting-authz-logic.ts`);
- a migration (`drizzle/`, `schema.ts`);
- the service worker (`public/sw.js`);
- a cascading delete;
- the session-less writes that mint PII: `captureGuestVisit` and `submitAccessRequestLogic`
  (`src/server/access-requests-logic.ts`, #866). Add the next public PII path here.

`/review-pr` prints a hint when a changed path is on that list; a silent hint is not a clean bill.
gstack's Codex passes fall back to a Claude subagent; do not install `codex`.

### Shaping and pipelines

A feature becomes issues and rides the same wave pipeline as a bug; `/spec` is the exit because
its Phase 3 produces the `## Files` section `batch:issues` needs. A `ready-for-agent` brief
satisfies superpowers' brainstorming gate. writing-plans and subagent-driven-development are
retired here.

```
room → file issues → /triage → ready-for-agent → batch:issues → worktree → /investigate → implement
                            │                                                → gh pr create → /review-pr → merge → /qa-only (per wave)
                            ├→ ready-for-human → /grilling → /spec → ready-for-agent
                            └→ needs-info → wait
idea → [brainstorming | /grilling] → /spec → ready-for-agent issues → (as above)
```

`/investigate` before implementing: given "the banner says the wrong thing", an agent patches the
banner; #448's cause was one line two functions away. `/browse` needs
`GSTACK_CHROMIUM_NO_SANDBOX=1` here.
