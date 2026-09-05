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

### Branch naming — the issue number goes LAST (required)

**`<slug>-<issue>`.** `fix-dialog-scroll-619`, not `fix-619-dialog-scroll` and
not `fix-dialog-scroll`. One branch closing several issues appends both:
`worktree-convert-guard-617-618`.

The name is not decoration — **it is the claim**. `bun run batch:issues` reads
these numbers back off `git worktree list` and off open PRs' `headRefName`, and
holds a claimed issue out of the plan. That is the only signal that exists
during the window duplicate work actually happens in: a worktree claim exists
from the first edit, before anything is pushed, and 7 of the last 10 merged PRs
here (measured 2026-08-31) carried no closing reference in the body at all, so
GitHub's own link could not have covered them.

Three rules, each with a failure behind it:

- **The number is a SUFFIX here.** The upstream this tool was ported from uses
  `fix/<issue>-<slug>` and reads leading tokens; this repo's branches already
  put it last, so `extractIssueNumbersFromRef` reads from the end. Prefixing
  the number instead makes the branch claim NOTHING — it is not an error, the
  issue simply gets handed out again.
- **A thematic name claims nothing, and that is deliberate.** Upstream's
  motivating collision was two sessions building the same fix twelve minutes
  apart, and neither saw the other precisely because both branches were named
  thematically. Do not "fix" this by guessing a number from the slug: holding
  back an issue nobody is working is a worse failure than the one it prevents.
  `sw-prime-on-visit` and `worktree-evaluator-reorder-positional` are real
  branches here that claim nothing.
- **Nothing may follow the number.** Reading stops at the first trailing token
  that is not all digits, so `fix-dialog-scroll-619-wip`, `-619-v2` and
  `-619-retry` all claim NOTHING and the issue gets handed out again. A retry
  needs a different slug, not a suffix. (`…-622a` correctly claims nothing for
  the same reason, which is the behaviour you want there.) The mirror case:
  `…-utf-8` would claim issue #8 — rare, and it only holds back one issue, but
  avoid ending a slug in a bare number that is not an issue.

`EnterWorktree` names the branch after the worktree and prepends `worktree-`,
so `git branch -m <slug>-<issue>` right after creating one is usually the
fastest way to comply.

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
  breaks replay — reserve `db:push` for throwaway/test databases (e.g. syncing `tm_test`). **`db:push`
  does NOT update a partial index's `WHERE` predicate on an index that already exists.** Changing
  `role_definitions_club_key_unique`'s predicate emitted a correct `DROP` + `CREATE` in the
  migration, and `db:push` silently left the OLD predicate on `tm_test` while creating the new
  sibling index beside it — so the test database enforced a constraint the schema no longer
  declared, and the tests that existed to prove the change failed for a reason unrelated to the
  code. `db:migrate` is right; after a `db:push` that touches an index predicate, verify with
  `select indexdef from pg_indexes where indexname = '…'` and recreate by hand if it is stale. `db:studio`
  to inspect.
- `bun run generate-routes` — regenerate `src/routeTree.gen.ts` (also runs during dev/build).
  **Dev and build append a footer to that tracked file that `tsr generate` does not produce** — an
  eight-line `declare module '@tanstack/react-start'` block. So a `git add -A` after `bun run dev`
  sweeps a build artifact into the commit, and nothing downstream catches it: the file is excluded
  from Biome, it is valid TypeScript so `typecheck` accepts it, and CI never regenerates the route
  tree to compare. It rode along three times on 2026-08-20 (#607, #613, #614). `.githooks/pre-commit`
  now blocks it, checking the STAGED blob and naming the fix
  (`bun run generate-routes && git add src/routeTree.gen.ts`, which strips the footer while keeping a
  real route change). It is the only gate on this, so `--no-verify` past it puts the artifact on main.
- `bun run build` — Vite build (Node server output via Nitro).
- `bun run typecheck` — `tsc --noEmit`. **This is the only thing that type-checks.** `bun run build`
  (Vite/esbuild) and `bun run test` (Vitest) transpile without type-checking, so both pass on
  type-broken code; run `bun run typecheck` before claiming a change is green. CI runs it in the
  `check` job.
- `bun run batch:issues` — group open `ready-for-agent` issues into waves that parallel agents
  can take without colliding, by FILE-disjointness read out of the issue bodies. `--label`,
  `--issues 619,618`, `--max`, `--fan-in`. Output is a plan; nothing is assigned or started.
  Logic in `src/lib/issue-batching.ts` (pure, testable), CLI in `scripts/batch-issues.ts`.
  It reads claims off live worktrees and open PRs, so the branch-naming rule above is what
  makes it work. Do NOT batch by THEME — theme correlates with files, and files are what
  actually conflict. It also serialises an issue labelled `migration` — not yet in the canonical
  label vocabulary below, so until it's added only a cited `drizzle/` path forces serialisation,
  and the CLI says so in its own output when nothing carries the label.
- Run a single test with `bunx vitest run <path>` (or `bunx vitest <path>` to watch).

**A suite that seeds a CLUB-LESS row must clean it up itself, and must not use a fixed key.**
`cleanup(clubId, userIds)` cascades from the club, so anything with a null `club_id` — a global
`meeting_templates` row is the first — survives it and leaks into the next run. Three further
traps, all hit for real: `cleanup` takes ARGUMENTS, so `afterEach(cleanup)` hands it vitest's
context and silently deletes nothing; vitest runs test FILES in parallel against one shared
`tm_test`, so a fixed global key collides across suites and an unscoped `delete(table)` takes
the other file's in-flight rows; and any assertion over an unscoped `select()` on a shared
table is order-dependent by construction. Give seeded keys and names a per-run suffix, track
the ids you created, delete only those, and scope every assertion to your own club.

**Integration suites need a database or they silently SKIP.** Export
`TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` before `bun run test`, or ~630
tests vanish from the run and the pass count still reads green. A plain `bun run test` masks stale
assertions that CI catches. `tm_test` is push-synced, so after a schema change run
`DATABASE_URL=…tm_test bun run db:push --force` — that is the one database `db:push` is for.

**The four browser-backed suites need Chrome — set `CHROME_PATH` to run them on a Mac.**
`src/components/agenda/print-page-count.test.tsx` renders each print surface, inlines the stylesheet
the route serves, and drives headless Chrome (`--print-to-pdf`) to count the sheets it produces.
`src/components/agenda/print-density.test.tsx` (v1.13.0.0) measures the natural height of the
editorial sheet and asserts how large the body text actually PRINTS. These are the only gates here
that can see print CSS at all, and they see different things: `FitPage` scales a sheet to fit, so the
page count reports 1 whether the page is comfortable or crushed, and a change can make the club's
agenda 20% less legible with every other gate green. Height is font size on those layouts.

`src/components/pinned-column-reachability.test.ts` (v1.21.0.0) is the third, and it is not about
print: it lays the app's two **pinned columns** out in the same browser and asserts you can still
scroll to the bottom of them. A column that is `sticky` with a height ceiling cannot grow, and being
pinned means the DOCUMENT scroll never reveals what spills out — so a missing scroller makes the
tail reachable by nothing at all, silently. That has now shipped twice: the meeting page's
attendance rail (v1.19.0.0, ~10 of 40 rows reachable) and the app-shell nav (~28 items on a short
laptop viewport, taking the sign-out control with it). Its fixture reads the real `className`
strings out of source, so deleting a scroller fails it, but the markup between them is synthetic —
mounting the real `SidebarInner` or `MeetingAttendancePanel` needs a router context and a mocked
`#/db`. So it pins the class COMBINATION, which is the half the source greps beside it cannot see:
`overflow-y-auto` on a flex child with no `min-h-0` is a box that grows instead of scrolling, and
satisfies every grep asking whether the class is present.

`src/components/ui/dialog-keyboard-reachability.test.ts` (v1.27.2.0) is the fourth, and it is the
one that cannot reproduce its own trigger: there is no way to raise a soft keyboard in headless
Chrome. It does not need to. The fix reads `visualViewport` and copies it into two custom
properties, and the CSS reads only those — so the harness (`src/test/dialog-keyboard-reach.ts`)
writes the properties itself, with the box a keyboard would leave, and measures what CSS then does.
That splits #619 into a JS half gated in jsdom (`src/lib/dialog-viewport.test.ts`: which events,
what is written, when it is torn down) and a geometry half gated here, with the PROPERTY NAMES as
the seam — imported from the same module the component imports, so the two halves cannot agree with
each other and disagree with the shipped class string. Generalise the shape rather than the trick:
when a browser cannot produce the input, find the narrow interface the fix actually reads and drive
THAT. It carries a pre-fix control that reproduces the bug, which is what makes the rest able to
fail.

No new dependency: the harness (`src/test/print-page-count.ts`) runs `$CHROME_PATH` if set, else
`google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser`, whichever runs first.
With none present those tests **skip locally**, so `bun run test` still works for someone without a
browser; **in CI they fail** instead (`CI has no Chrome on PATH`), because a silently absent
geometry gate reads exactly like a passing one — the same failure shape as the DB-backed suites above.
`ubuntu-latest` ships Chrome, so CI needs no install step; the dependency is named in
`.github/workflows/ci.yml` beside the `check` job's `Test` step so a runner-image change is
diagnosable. Beside that job's ONLY — the `extension` job is `working-directory: extension` and
runs the sub-package's own three-file vitest, which touches no browser. It carried a copy of the
same Chrome comment until v1.22.8.0, naming suites that working directory cannot see.

**On macOS all four skip unless you set `CHROME_PATH`**, because Chrome installs as an `.app` and
puts nothing on `PATH` under any of those four names. This is a macOS-only gap: on Linux, where this
repo is usually developed, `google-chrome` resolves and both gates run locally as normal. Do NOT
"fix" it by hardcoding `/Applications/Google Chrome.app/...` in `CHROME_BINARIES` — that binary
answers `--version`, so `findChrome` accepts it, but it never returns from `--print-to-pdf` under the
agent sandbox, which turns an honest skip into 135s of `ETIMEDOUT`. A browser that is found but hangs
is worse than one that is not found. A Playwright `chrome-headless-shell` works and returns in ~0.2s:

```bash
CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell" bun run test
```

Numbers measured through this harness are NOT comparable to the deployed page: it runs with
`--host-resolver-rules=MAP * ~NOTFOUND`, so Fraunces and Manrope never load and the platform's
substitute has its own metrics. That substitute also differs between macOS and CI's Ubuntu and moves
where lines wrap, which is why the point floors in `src/lib/agenda-print-type.ts` carry a wide margin
and the exact declared sizes are pinned by a separate assertion.

**Read the lint gate with `--diagnostic-level=error`.** `src/db/seed.ts` carries ~118 pre-existing
`noNonNullAssertion` warnings, which Biome does not fail on, so the tail of a `bun run check` run is
a wall of noise and a single real error scrolls past. `bunx biome check --diagnostic-level=error` is
the readable view. Run the gate LAST, before commit, with CI's bare invocation — `biome check src/`
skips files a bare run includes.

## Test Coverage

Minimum: 60%
Target: 85%

Assessed against the diff, not the whole repo: every branch, error path and user flow the change
introduces should have a test that exercises it. The coverage traps this repo has hit, the ones a
green number hides, live in `CODING_STANDARDS.md` ("Test coverage"), which `/review-pr` reads. Read
them before writing a test for a rendered-geometry property, a cap, a guard, or a computed prop.

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
- **Three longer rules live in `CODING_STANDARDS.md` ("Conventions")**, each with the bug that
  earned it: print routes share one stylesheet (`PRINT_PAGE_CSS`); the global text-link rule is
  layered and a component's own colour utility wins, so do NOT add a `:not()` arm or `!important`;
  and a dialog's height belongs to the `DialogContent` primitive, so a call site must not set
  `max-h` or `overflow-*`. A guard test enforces each; the standards file says why.

## Data layer

Schema is `src/db/schema.ts` — the full domain model (~39 tables): clubs,
people/members (Person vs Membership, ADR-0008), officer_terms, meetings,
role_definitions/role_slots (ADR-0005), meeting_attendance_plan and
meeting_attendance (the PLAN and the RECORD — two tables, never one, see
`CODING_STANDARDS.md`), speeches (ADR-0009), the Pathways model (pathways_paths, path_enrollments,
path_level_progress, pathways_projects, pathways_path_levels,
bcm_project_progress — ADR-0011), sync_tokens, activity_log, club_logos (a
club's own uploaded logo, bytea, ADR-0024 — rendered on the four print
layouts, the projected deck, the `.pptx` export, the Word of the Day poster
and the club role sheets, HTML and PDF), digital voting (`meeting_vote_sessions`
/ `meeting_votes` / `meeting_ballot_guests`, #510 — see `CONTEXT.md`'s
**Digital vote** entry), Club Officer Training (`officer_training_periods` /
`officer_training_records`, #531 — the record behind DCP goal 9; the periods
table is a SPARSE override of TI's own window dates, so **row absent = the
default**, see `CONTEXT.md`'s **Club Officer Training (COT)** entry), and
notifications (drained by an in-process poller, ADR-0023). Better-Auth's tables
live in `src/db/auth-schema.ts`. See `CONTEXT.md` for the glossary.
The `db` client (`src/db/index.ts`) is `drizzle(process.env.DATABASE_URL!, { schema })`.
Migrations are generated to `./drizzle` (`drizzle.config.ts`); edit the schema, then
`bun run db:generate` + `bun run db:migrate` (do NOT `db:push` the dev DB — see the `db:migrate`
note above). CI fails if
`schema.ts` drifts from the committed migrations (a generate that produces a diff) and applies
migrations (not `push`) so the migration files are exercised the same way prod runs them.
`drizzle-orm` 0.45.1 has no built-in `bytea` type; `schema.ts` defines one once via `customType`
(`export const bytea`, used by `club_logos.bytes`) — reuse that export, don't redefine it.

The invariants that make this schema safe to touch live in `CODING_STANDARDS.md` ("Data layer"),
which `/review-pr` reads: planned attendance is one table read through one seam, with two exact
floors on what a caller may overwrite or clear; the plan and the record are two tables and roll
mode is the record's only writer; server-fn modules export only `createServerFn`s and types so
`pg` stays out of the client bundle; and the archive gate has four read-side enforcement points
plus a write-side assert, none of which is the route guard. Each has a guard test that fails you
first; the standards file is where the reason lives, and CONTEXT.md holds the glossary entries
they cite.

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

**Changing a `createServerFn`'s `method` is a BREAKING change for tabs already open**, and
auto-deploy on push is what makes that reachable. A server fn's URL is derived from its file and
export name, not from its body, so the URL is byte-identical across the deploy while the server
now enforces the new verb strictly (405 with an `Allow` header). A client loaded before the
deploy keeps calling the old method against the new server and gets a 405 the router surfaces as
a failed loader — a blank page, not a stale one. #504 flipped `getClubLogoMeta` POST → GET and
handled it by making the last call site `.catch(() => null)` like the other five, so a stale
client degrades to "no logo" instead of blanking club settings. The rule generalises: when you
flip a method, every caller needs a fallback in the SAME change, and a guard test is the only
thing that can hold it — a `createServerFn` cannot be invoked from vitest and call sites
`vi.mock` the module wholesale, so the transport is invisible to the whole suite
(`club-logo-method.guard.test.ts`).

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `abustamam/tm-scheduler` (managed via the `gh` CLI); external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

#### What earns an issue

File one only when it is (a) a correctness or security bug a user can actually hit, or (b) work
you would genuinely schedule. Everything else becomes a comment at the call site or an item in
`TODOS/<branch-name>.md`, and is reported in the PR body or the session summary instead.

This exists because the default pulls the other way. A reviewer's job is to find things, so every
review surfaces more than one PR can absorb; filing each leftover finding is a
ratchet that grows the backlog by construction. One session closed 2 issues and opened 5 — of which
exactly one was a real bug. The other four were a two-line index, a debt note already recorded in a
code comment, and an edge case needing a three-step repro.

Two second-order costs make the bar higher than it looks:

- Labelling review residue `ready-for-agent` inflates the queue that implies real work, which is
  the number you actually plan against.
- A filed issue has a maintenance tail. Closing one as noise leaves any code comment that
  references it pointing at a dead number.

`TODOS/README.md` states the boundary: a file holds in-flight debt not worth an issue yet, and is
swept — promote, drop, or leave — at every `/retro` and whenever `batch:issues` comes back empty.
Respect that direction rather than inverting it.

### Triage labels

Canonical label vocabulary, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by `/domain-modeling`). See `docs/agents/domain.md`.

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

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt,
invoke the skill.

This section was rewritten on 2026-09-04. The ethos: MVP phase, live users, one maintainer who
steers specs rather than writing code. Review effort goes where it has been shown to pay and
nowhere else, release ceremony is zero, and deferred debt is per-branch and deleted rather than
logged. `/ship` no longer runs here. The ~210 lines this replaced were about its cost; their
measurements are in git history (#672, #673) if a release cadence ever comes back.

| To… | Use |
|---|---|
| Shape a feature | brainstorming or `/grilling` as the situation calls for, then **always `/spec`**. Its output is one or more `ready-for-agent` issues citing files. `/plan-eng-review` only if `/spec` emits three or more. |
| Triage the room's issues | `/triage` |
| Plan a wave | `bun run batch:issues`, acted on per the `dispatching-issue-waves` project skill |
| Debug | `/investigate`. It is the debugging skill here and satisfies superpowers' systematic-debugging gate. |
| Open a PR | `gh pr create`. The agent stops there. |
| Review a PR | `/review-pr N` from the main session. gstack `/review` in the PR's worktree **as well** for a risk category (below). |
| Land | `gh pr merge --squash --auto`. Branch protection requires the branch to be up to date with `main`, so after each PR lands run `gh pr update-branch N` on the rest; CI re-runs and auto-merge fires when green. |
| Verify a wave | `/qa-only` against the deployed app, once per wave after it has all landed, before the next meeting. Findings become issues. |
| See what shipped | `/retro` (gstack). `/session-retro` is the other one: what in the agent's environment made a session harder than it needed to be. |
| Park debt | `TODOS/<branch-name>.md`, several items per file, deleted when done. Swept at `/retro` and whenever `batch:issues` comes back empty. `TODOS/README.md` has the lifecycle. |

### Pull requests

- **Title**: conventional-commit style, `fix(agenda): …`, with no version prefix. `VERSION` is
  frozen at `1.32.0.0` and `CHANGELOG.md` stops there; do not bump either. Nothing reads them.
- **Body**: `Closes #N` is mandatory. Branches are deleted on merge, so a merged PR without it
  leaves the issue open with no claim on it, and the next `batch:issues` hands it out again.
  Everything else in the body is optional.
- **A wave agent never merges its own PR.** Merging happens from the main session, after
  `/review-pr`. A wave PR is green against the `main` that existed when its CI ran, so branch
  protection requires the branch to be up to date before it merges (`strict: true`, set
  2026-09-05): after each PR lands, `gh pr update-branch N` on the others and let CI re-run.
  Before this, `/ship` merged `main` into the branch before testing and nothing else checked.
  A merge queue would do the updating unattended, and it was the first choice, but GitHub offers
  it only on organization-owned repositories and this one is user-owned (the rulesets API
  returns an empty-reason 422 on a `merge_queue` rule). `ci.yml` keeps its `merge_group:`
  trigger, inert today, so the queue is one setting away if the repo ever moves to an org.

### Which review

`/review-pr` runs the Matt Pocock code-review skill's two axes, Standards (repo conventions plus a
fixed smell baseline) and Spec (does the diff do what the issue asked), against the PR's branch on
`origin` with no checkout. Neither axis asks who may now write or delete another person's record.
#573 did exactly that in 81 lines across 2 files with every gate green, so for a **risk category**
run gstack `/review` in the PR's worktree as well, at any size:

- authentication or **authorization**: anything changing who may write or delete another
  person's record;
- the archive gate (`guards.ts`, `club-readable-logic.ts`, `meeting-authz-logic.ts`);
- a migration (`drizzle/`, `schema.ts`);
- the service worker (`public/sw.js`);
- a cascading delete;
- `applySelfAdd`.

`/review-pr` prints a hint when a changed path is on that list. Paths cannot see an authorization
change in an unrelated file, so a silent hint is not a clean bill. gstack's Codex passes fall back
to a Claude subagent here because the `codex` CLI is not installed; do not install it, it does
nothing without credentials.

### Shaping

A feature becomes issues and rides the same wave pipeline as a bug. brainstorming answers "what
should this be", `/grilling` answers "here is my position, break it", and either is optional.
`/spec` is the exit, because its Phase 3 reads the code and produces the `## Files` section
`batch:issues` needs. A feature too big for one issue leaves `/spec` as several, linked with the
`depends on #N` lines the planner recognises. A `ready-for-agent` brief satisfies superpowers'
brainstorming gate; do not re-run it on a dispatched issue. writing-plans and
subagent-driven-development are retired here.

### Pipelines

```
room → file issues → /triage → ready-for-agent → batch:issues → worktree → /investigate → implement
                            │                                                → gh pr create → /review-pr → merge → /qa-only (per wave)
                            ├→ ready-for-human → /grilling → /spec → ready-for-agent
                            └→ needs-info → wait
idea → [brainstorming | /grilling] → /spec → ready-for-agent issues → (as above)
```

`/investigate` before implementing is the one insertion on the agent path worth defending: given
"the banner says the wrong thing", an agent patches the banner. #448 listed "soften the banner
copy" as an option, and the cause was one line in a marker pass two functions away.

Work from a worktree, never the main checkout; see "Git worktree isolation" above. `/browse` needs
`GSTACK_CHROMIUM_NO_SANDBOX=1` here.
