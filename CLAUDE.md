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
introduces should have a test that exercises it. `/review-pr`'s Standards axis reads this section,
so the traps below are what a diff is held to.

Nine coverage traps this repo has actually hit, all worth checking when a number looks fine:

- **A test can pin the wrong thing after a rename.** An assertion matching a role name by string
  (`r.who === "Toastmaster of the Day"`) stopped being unique once a second beat rendered the same
  owner, so it passed while the row it was written to protect could have been deleted. Assert on
  something that identifies the row, not just its owner.
- **A source guard's own vacuity floor erodes silently when it counts a PROXY.** Most guards here
  carry one ("did the extraction actually find anything?"), and it is only as good as the thing it
  counts. `club-logo-copy.guard.test.ts` counted quoted string literals in the extracted
  `CLUB_LOGO_COPY` block against a floor of 10; #504 made three of those values template literals
  so they could interpolate the shared caps, dropping the census from 19 to 16 while the object
  GREW — no failure, and the floor now had a third less headroom than the day it was written. The
  proxy is the bug: count the STRUCTURE the guard is about (keys of the object) rather than a
  lexical accident of how the values happen to be written today, since the next value that stops
  being a plain string erodes it again by the same silent amount.
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
- **A "no extra query" test that spies a NAMED loader stops being able to fail the moment that
  query is inlined.** Same family as the bullet above — the observable is the QUERY, not the
  result, because "reads the `clubs` row once, not twice" returns byte-identical data either way
  — but WHICH seam you spy on decides whether the assertion survives the refactor it polices.
  `season-grid-cc-query.integration.test.ts` asserted `loadClubDefaultCountryCode` was not called;
  the fix folded that column into an existing `findFirst`, which DELETED the call, leaving a test
  that could only pass. Count at the driver instead: `statementsDuring` / `readsOf`
  (`src/test/query-spy.ts`) spy on `db.$client`, the node-postgres Pool under drizzle, so they are
  indifferent to how the statement was built. Two blind spots there, both silent and both shaped
  like success — statements issued inside `db.transaction()` run on a `PoolClient` the spy never
  wrapped, so a transactional loader reports ZERO; and a driver change that broke `readsOf`'s
  pattern reports zero too. Assert the list is non-empty before trusting a count.

- **A fixture that spans ONE axis is not a guarantee.** When the thing you are protecting is a
  property of rendered output — a page count, a printed word, a render cost — the test is only as
  good as the widest fixture it runs. On 2026-08-04 the role sheets' one-page promise was wrong
  **four times in a row**, each time with a green suite: 24 log rows (chosen against cost only),
  10 rows (measured without a club logo), 8 rows (measured with short speaker labels), and a
  34-character club name that nothing had varied. Before writing the test, LIST every field that
  is unbounded user data and build the fixture matrix from that list — including all of them at
  once, which is the case no single-variable fixture catches. The list includes each field's
  CHARACTER CLASS, not only which fields are unbounded: a length cap bounds code points, not cost,
  and #522 measured emoji rows costing ~13x ASCII rows through the same renderer at the same
  capped size (200 rows x 440 ASCII chars → 217ms; 200 rows x 200 emoji points → 2,778ms). An
  all-ASCII fixture sized the minutes row caps 3x too high, and the all-axes-hostile version still
  took 8.9 seconds with every string cap correctly applied. A merge makes this worse: two
  branches touching the same output each test their own axis, and the cross-product is tested by
  neither, so re-derive the list after merging.

- **A test stated RELATIVE to the constant it guards cannot fail.** When the fix IS a number — a
  cap, a limit, a timeout — `expect(x.length).toBeLessThanOrEqual(CAP)` passes for every value of
  CAP, including one that reintroduces the bug. On #519 raising `speakerRows` to 5,000 kept 90/90
  green while one public request cost 129 seconds of blocked event loop, and raising the
  Word-of-the-Day limits to 49,999 kept 103/103 green at 3.7 seconds. Assert an ABSOLUTE ceiling on
  the constant, picked by measuring the cost curve (500 and 5,000 characters both rendered in 39ms;
  49,999 took 3,707ms — so the ceiling goes far below that knee). Corollary: a schema private to a
  server-fn module is invisible to vitest, so its whole layer can be deleted with the suite green —
  that needs a comment-blind source guard via `#/test/guard-source`. Second corollary, same effect
  by a different mechanism: a constant defined in a module that imports `#/db` at load is equally
  unassertable, because a unit test importing it throws `DATABASE_URL is not set`. #522 shipped its
  minutes render caps inside `minutes-pdf-logic.ts` first, where they could have been raised to
  5,000,000 with the whole suite green — inside the very change that cites this trap. Put the
  NUMBERS in `lib/` (`src/lib/minutes-render-caps.ts`, `src/lib/speaker-limits.ts`,
  `src/lib/club-logo-limits.ts`) and let the renderer import them. The logo case (#504) adds the
  second reason to do it, and it is not about testability at all: a number the CLIENT also has to
  agree about cannot live in a `#/db`-importing module, so it gets RE-DECLARED there instead —
  four files spelling the club-logo caps, held together by a comment saying "keep these in sync"
  and identifiers that look shared but resolve to different symbols. That had already drifted
  silently: #496 added the pixel cap server-side and the client never learned it, so an admin
  could pick a 4000px logo, watch the client accept it, base64 the whole file, and be rejected
  only after the round trip. One declaration plus an offender-sweep guard
  (`club-logo-limits.guard.test.ts`) is what makes a matching identifier in four files fail
  instead of rot.

- **jsdom performs no layout, so a property of rendered GEOMETRY is untestable in process.** Print CSS
  was invisible to every gate here for exactly that reason: a missing `.pgwrap { padding: 0 !important }`
  reset put a blank second sheet on every Word of the Day poster and got past six test files, typecheck,
  lint and two reviews (v1.3.0.0). The component tests were not weak — they asserted the DOM, and the DOM
  was right. The defect only exists inside a paginating engine. So when the thing you are protecting is a
  page count, a wrap point, an overflow, or a `@media print` rule, the test has to run a real engine:
  `src/test/print-page-count.ts` prints the surface through headless Chrome and counts sheets, and
  deleting that reset now fails with `expected 2 to be 1`. Two things that harness learned the hard way
  generalise to any such test. The fixture must reproduce the **route's** wrapper elements, not just the
  component — `.pgwrap` lives on the word route's page component, not on `WordOfTheDayPoster`, and
  without it the reset can be deleted with the count unchanged; the same for `.no-print`, which needs the
  route's toolbar and footer present or nothing observes it. And `toBe(1)` is not proof of content:
  Chrome exits 0 and writes a valid one-page PDF for an empty body or a missing file, so a component that
  starts returning null reads as PASS — which is why an empty-document control sits beside the real
  assertions, making the unstated zero explicit. Source greps still earn their place next to it: the grep
  pins the RULE and catches a deletion in review, the render pins the RESULT and catches a geometry change
  no grep can see. See #502.

- **A component tested through its props cannot see a WRONG prop.** The props are the fixture, so a
  thorough component suite says nothing about the expression that computes them at the call site.
  #319 shipped exactly there: `VisitCta` and `AboutClub` were both well covered, and the bug was in
  neither — the route wired `isMember={shell}`, true only for a SIGNED-IN member, so a member who
  identified through the anonymous roster pick (the dominant path in this no-auth product) was shown
  "Planning a visit? Guests are always welcome" on their own club's sign-up sheet. The whole
  3,437-test suite was green. Rendering `club.$clubId.index.tsx` to observe that boolean means
  standing up a QueryClientProvider, the identity gate, the commitments query and the entire
  SeasonGrid — a large brittle fixture for one expression — so the reachable gate is a comment-blind
  source guard on the JSX (`club-index-wiring.guard.test.ts` via `#/test/guard-source`), pinning the
  prop expression and the elements that carry it. Two generalisations. When you finish a component's
  tests, LIST the props that are COMPUTED rather than passed through: those are untested by
  construction, and each one is a place this trap fits. And a prop named for the NARROWER of two
  identities invites the narrower read — `isMember` was renamed `hasIdentity` in the fix, which is
  why the guard also fails on the old name. That guard reads comment-blind (`readSource`) for both
  of the reasons in `src/test/guard-source.ts` at once: its "this pattern must BE present"
  assertions would falsely PASS on a comment merely naming the pattern, and its own file header
  quotes `isMember={shell}`, which would falsely FAIL the one negative assertion read raw.

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
- **Print routes share one stylesheet — do not hand-roll page CSS.** `PRINT_PAGE_CSS` in
  `src/components/agenda/print-theme.tsx` is the single copy of the `@page` / `.pgwrap` / `.no-print`
  rules that keep a print surface to its sheet count, and `PrintToolbar` / `PrintButton` are the shared
  toolbar. The agenda print route, the Word of the Day poster and the club role sheets all inject it; it
  was three divergent copies until v1.8.4.0, so a print fix meant finding all three and guessing which
  differences were deliberate. A new print route imports the constant. `print-page-reset.guard.test.ts`
  walks `src/routes/` recursively and fails on a route that defines its own `.pgwrap` padding, so the
  next print route is enrolled automatically rather than remembered.
- **The global text-link rule is LAYERED — a component's own colour utility wins.**
  `src/styles.css` styles bare `a` inside `@layer base`. Tailwind v4 declares
  `@layer theme, base, components, utilities`, and layer order beats specificity, so any
  component setting `text-*` on its own anchor gets that colour with no opt-out needed. Add a
  coloured anchor anywhere and it just works; there is nothing to enrol.
  **It was UNLAYERED until #646, and that cost seven bugs**, which is why this entry exists.
  Unlayered CSS beats every layered rule regardless of specificity, so the rule silently
  overrode whatever a component set: the landing "Sign in" button read teal-on-teal in dark
  mode, the meeting Print & export menu (#541) split one menu of peer actions into two
  apparent classes, the WhatsApp phone/`mailto:` pair rendered `--lagoon-deep` (#328f97,
  3.81:1 on white) on the four surfaces that show contact, `BackLink` went the same way at
  `text-sm`, and the meeting date strip's ACTIVE pill — `bg-primary text-primary-foreground` —
  put its label on its own fill at 1.19:1 in dark (#645). Each was fixed by adding another
  `:not([data-slot="…"])` opt-out arm. The arm count reached seven while **26 anchors were
  still broken**, because opt-out enrols nobody. Two lessons worth keeping. Severity tracked
  whether the anchor had a FILL: on plain text it degraded to 3.81:1 (under AA, still
  legible), but on a fill it landed at 1.19:1 — same mechanism, an order of magnitude worse,
  and the only signal separating them was `bg-*` on the anchor. And the sweep that found the
  26 initially found only 12, because its regex matched named tokens and missed every
  arbitrary value (`text-[var(--sea-ink)]`); when grepping for utilities, remember
  `text-[…]` is one.
  **Do NOT re-add a `:not()` arm and do NOT add `!important`** — either makes the rule beat
  utilities again and reopens all 26 at once. Do not add an unlayered `a { color }` rule
  anywhere either; that is the original shape. `.prose-gavelup a` is the one waived
  unlayered anchor rule (scoped to markdown, deliberate, predates #646).
  The five bespoke `data-slot`s (`wa-phone`, `wa-email`, `back-link`, `guest-book-link`,
  `meeting-nav-link`) survive on their components as TEST SELECTORS — three non-colour
  suites assert them — and no longer opt anything out; `data-slot="button"` and
  `dropdown-menu-*` are shadcn-native and unrelated.
  Nothing in-process can see any of this: jsdom loads no stylesheet, the print page-count
  harness inlines only `PRINT_PAGE_CSS`, typecheck and lint have no view of the cascade, and
  `bun run test` never parses `styles.css` as CSS at all. The gate is therefore a source
  grep, `text-link-layering.guard.test.ts` (comment-blind via `#/test/guard-source` for the
  must-be-present half, RAW for the offender sweep), which fails if the rule leaves
  `@layer base`, if an unlayered bare-`a` colour rule appears, if an arm returns, or if
  `!important` is added. To verify the cascade for real you must build: `bun run build`, then
  grep the compiled bundle — and note the minifier strips quotes, so match
  `[data-slot=x]`, not `[data-slot="x"]`.
- **A dialog's height belongs to the primitive — do not re-solve it at the call site.**
  `DialogContent` (`src/components/ui/dialog.tsx`) is a non-scrolling SHELL carrying the
  ceiling and the padding, wrapped around a `data-slot="dialog-body"` child carrying
  `min-h-0 overflow-y-auto overscroll-contain`, and the COMBINATION is the
  fact: it is `fixed` and centred by `translate-y-[-50%]`, so a box taller than the viewport
  hangs off both ends and the document cannot scroll it back — a fixed element is not in the
  scroll flow, so the overflow is not below the fold, it is unreachable. Measured before the fix
  at a 375x400 viewport: the identity dialog rendered 457px tall at top=-28 with the
  "I'm new — add me" control at y=404 and NO scrollable ancestor between it and the body. Three
  rules from it. `svh`, never `vh` — `vh` is the LARGE viewport height, so it under-accounts for
  mobile chrome and lands the ceiling below the fold on the devices that need it; the two local
  patches this replaced were both `max-h-[80vh]`. A call site must not set `max-h`,
  `overflow-y-*`, **or `overflow-hidden`** — `cn()` is tailwind-merge, so `overflow-hidden`
  resolves OVER the primitive's `overflow-y-auto` and silently removes the scroller while
  keeping the ceiling, which is the original bug one dialog at a time (`CommandDialog` does this
  deliberately and is the one waiver). And nothing in-process can see any of it — jsdom performs
  no layout — so the gate is a source guard (`dialog-scroll.guard.test.ts`, comment-blind via
  `#/test/guard-source` for the must-be-present half, raw for the offender sweep, whose tag scan
  is brace-aware because a JSX prop can contain `>` and prop ORDER was all that kept the naive
  regex working).
  **The ceiling is measured against the VISUAL viewport, and that is a second mechanism, not a
  refinement of the first.** An `svh` ceiling alone was correct and never ENGAGED with the
  on-screen keyboard up: the viewport meta names no `interactive-widget`, so the platform
  default `resizes-visual` shrinks the visual viewport and leaves the layout viewport — which is
  what `svh` resolves against — untouched. A 533px identity dialog therefore still fitted under
  `100svh`, nothing overflowed, the body scroller never engaged, and the bottom of the dialog was
  not below the fold but behind the keyboard, reachable by nothing (#619; #627, the close button
  scrolling away with the content, is closed and is why the shell/body split exists).
  So `#/lib/dialog-viewport` copies `visualViewport` into two custom properties while a dialog is
  open and the shell sizes AND centres against them, with `100svh`/`0px` as the `var()` fallbacks
  so SSR and any engine without the API render exactly what v1.25.2.0 did. Four things to keep.
  Sizing without RE-CENTRING fixes nothing — a correctly shrunk dialog still centred on the layout
  viewport is still under the keyboard, which is why `top` reads the properties too and why
  `offsetTop` (iOS scrolls the visual viewport to clear a focused input) is a failure mode
  separate from height. The subscription is REF-COUNTED and lives inside `DialogPortal`, whose
  children mount only while open: in `DialogContent` itself it would run for every dialog
  component in the tree open or not, and a boolean would let a nested dialog's unmount clear the
  properties out from under the dialog still on screen. `interactive-widget=resizes-content` was
  the issue's first candidate and was NOT taken — MDN's browser-compat-data has no entry for it
  under `meta[name=viewport]` at all, so it is unverified off Chrome and the worked example is an
  iPhone; it also changes every `svh`-sized surface app-wide. It composes cleanly if ever adopted.
  And the JS↔CSS seam is the PROPERTY NAMES: a Tailwind arbitrary value is scanned statically, so
  the class string cannot interpolate the exported constants, and a rename on one side alone makes
  `var()` fall back silently with every gate green — `dialog-scroll.guard.test.ts` asserts the two
  spellings match. Geometry is gated by `dialog-keyboard-reachability.test.ts`, which lays the real
  class strings out in headless Chrome with the properties set to what a keyboard leaves (269px of
  a 560px SE viewport) and carries a pre-fix CONTROL that reproduces the bug, so the suite can
  demonstrably fail; verified by mutation (reverting the two utilities fails 3 of its cases, the
  shell bottom landing at 544px against the 269px keyboard line).

## Data layer

Schema is `src/db/schema.ts` — the full domain model (~35 tables): clubs,
people/members (Person vs Membership, ADR-0008), officer_terms, meetings,
role_definitions/role_slots (ADR-0005), meeting_attendance_plan and
meeting_attendance (the PLAN and the RECORD — two tables, never one, see
below), speeches (ADR-0009), the Pathways model (pathways_paths, path_enrollments,
path_level_progress, pathways_projects, pathways_path_levels,
bcm_project_progress — ADR-0011), sync_tokens, activity_log, club_logos (a
club's own uploaded logo, bytea, ADR-0024 — rendered on the four print
layouts, the projected deck, the `.pptx` export, the Word of the Day poster
and the club role sheets, HTML and PDF), digital voting (`meeting_vote_sessions`
/ `meeting_votes` / `meeting_ballot_guests`, #510 — see `CONTEXT.md`'s
**Digital vote** entry), and notifications (drained by an in-process poller,
ADR-0023). Better-Auth's tables live in `src/db/auth-schema.ts`. See
`CONTEXT.md` for the glossary.
The `db` client (`src/db/index.ts`) is `drizzle(process.env.DATABASE_URL!, { schema })`.
Migrations are generated to `./drizzle` (`drizzle.config.ts`); edit the schema, then
`bun run db:generate` + `bun run db:migrate` (do NOT `db:push` the dev DB — see the `db:migrate`
note above). CI fails if
`schema.ts` drifts from the committed migrations (a generate that produces a diff) and applies
migrations (not `push`) so the migration files are exercised the same way prod runs them.
`drizzle-orm` 0.45.1 has no built-in `bytea` type; `schema.ts` defines one once via `customType`
(`export const bytea`, used by `club_logos.bytes`) — reuse that export, don't redefine it.

**Planned attendance is ONE table with a status, read through ONE seam.**
`meeting_attendance_plan` holds one row per (member, meeting) carrying
`reached_out | coming | not_coming`; **row absent = "no answer"**. It replaced the two
presence-means-true tables `member_availability` and `meeting_outreach`, which are dropped.
Row presence is therefore no longer the answer: a consumer asking "who is unavailable?" must
filter `status = 'not_coming'`, and one asking "who was contacted?" must filter
`status = 'reached_out'` (the officer-only rung) — testing for a row now silently counts all
three. `src/server/attendance-plan-logic.ts` is the seam: `getPlanStatus`,
`listPlanForMeetings`, `listNotComingWithNames`, `listNotComingForMeetings`,
`listReachedOutForMeeting`, `listComingForMeeting`, `setPlanStatus`, `clearPlanStatus`. Add a
function there rather than an inline query — the seam is where the actor attribution and the
two status predicates live, and an inline query bypasses both while still typechecking.

**What the officer's rail DISPLAYS is not what the seam returns** (v1.19.0.0). `buildPlanPanel`
(`src/lib/attendance-panel.ts`, with `buildPanelRoleMap` beside it) resolves a display rung per
member: an explicit `coming`/`not_coming` wins, else a **confirmed** `role_slots` row reads as
`coming` with `assumed: true`, else the stored `reached_out` or null. Pure derivation, no write —
the table gains no row, and `listComingForMeeting` still answers with stored rungs only, so the
rail's coming count is a superset of the seam's BY DESIGN. Both halves live in `src/lib` rather
than in the route for the usual reason: a route cannot be mounted in vitest, so a derivation there
is guarded only by source greps, and mutation review found two bugs in this one that pass every
grep and a clean typecheck. See CONTEXT.md's **Planned attendance** entry.

**The seam does NOT carry the archive gate or the officer-only `reached_out` rung**, and
reading it as if it did is how the consolidation nearly shipped an authorization regression.
Both belong to the CALLER: `attendance-plan.ts` resolves the actor and gates on
`clubs.archived_at`, and the public delegates in `availability.ts` do their own
`assertClubNotArchived`. Note the rung is officer-only in NAME only since #576 — `resolveActor`
has three arms, and the middle one admits this meeting's Toastmaster WITHOUT a session, by
comparing a self-asserted member id against the meeting's TMOD slot. So "needs a session" is
the wrong mental model for who may write it; `viaManager` (not the officer arm) is the gate.
It does not widen `onlyFrom` on the clear — that arm stays `via === "officer"`, because deleting
another officer's record of having asked is not what the panel is for and the TMOD claim is
honour-system. Note "stays on the officer arm" is about WHICH arm, not about how much it may
delete: since #573 the officer arm is FLOORED too (see below). Same split on the read: `getTmodPanelData` gives the TMOD the ladder and names on
the claim, but phone and email only to a real session (#576 review). WHICH arm admitted a write
is persisted as `activity_log.detail.grantedVia` (`officer | tmod | self`), because a grant
defended as "auditable afterwards" is not auditable while an honour-system TMOD write and a
session-authenticated officer's look identical in the feed. It is optional on the seam so the
callers with no ladder (`setAvailability`, the self-claim path) need no change — which also means
a new caller drops it silently. Pass it. What the seam CAN enforce without a session is that one rung does not
silently overwrite another, and it takes that from the caller too: `setPlanStatus`'s
`demoteFrom` names the statuses a write may replace (`setContacted` passes `["reached_out"]`,
so ticking "contacted" can never demote a real answer, and `setPlannedAttendance` passes the
same floor on `reached_out` when the panel's WhatsApp/email tap auto-advanced someone
(`data.via === "nudge"`) **or** when the resolved arm was the Toastmaster's (`via === "tmod"` —
the two `via`s in that one expression are different things). Read
that second condition carefully: the TMOD is floored on BOTH write paths, deliberate menu pick
included, since one forged request per member would otherwise mark the whole roster "Asked" and
erase every answer invisibly — `answeredRungs` filters `reached_out` out, so the officer's panel
would read "all contacted, nobody declined". Only an OFFICER's deliberate menu pick is unfloored,
which is what keeps "Asked" from silently no-opping on a row that already answered for the one
caller a session authenticated), and `clearPlanStatus`'s `onlyFrom`
names the statuses a delete may remove, and since #573 it is **REQUIRED** — there is no
"clear whatever is there" any more, and its absence used to be the hole. The two floors are exact
COMPLEMENTS, defined beside each other: `SELF_SERVICE_RUNGS` (`coming | not_coming`) is what a
self/TMOD caller may clear, `CLEARABLE_ASK` (`reached_out`) is what an officer may clear. A member
clears an ANSWER; an officer clears the ASK; neither may erase the other's. So a plain member and a
self-asserted Toastmaster still cannot erase an officer's `reached_out` — which deleting a
`meeting_outreach` row used to require an admin to do — and an officer can no longer erase a reply.
Do NOT restate the officer half as "`viaManager` gets the unrestricted clear": an earlier draft of
this paragraph did, that was the first cut of #576 and never HEAD, and the two sentences
contradicted each other four lines apart. The write ladder widened to `viaManager`; the delete
stayed on `via === "officer"`, which needs a session.

That officer arm passed NO floor until #573, and the failure is worth keeping because it is a
shape rather than a slip: "No answer" means *make it as if they never replied*, so it must never
destroy a reply — the rail does not poll, so a row can still read `Asked` while the server already
holds `not_coming`, and deleting that drops the member off `unavailableMembers` and out of the
recruit picker's warning, after which they can be handed a role they declined. Nobody decided
officers needed that power; a one-tap menu item was wired to a delete whose floor was OPTIONAL, and
omitting a parameter looked sanctioned. Correcting a wrong answer is the SET path, where
`demoteFrom` deliberately leaves an officer's deliberate pick unfloored. The accepted trade-off is
that an answered row can no longer be returned to "no answer" — same shape as roll mode's
clear-to-unmarked gap; an officer who wants a row to stop saying "coming" picks "Not coming".

Both `demoteFrom` and `onlyFrom` are `setWhere`/`WHERE` predicates rather than a
read-then-write, so they are also the de-dup and race fix for `markComingOnSelfClaim`.

`attendance-plan-store.guard.test.ts` enforces both halves across `src/` **and**
`scripts/`, matching the snake_case SQL name and the drizzle symbol alike (a raw
`sql` template is invisible to typecheck): no file may name the two dropped tables, and no
non-test source file outside the seam may name the plan table — `schema.ts` and
`membership-collapse-logic.ts` (whose merge de-dups in raw SQL before re-pointing) are its only
waivers.

**The plan is one of TWO attendance tables, and since v1.20.0.0 the same panel writes both.**
`meeting_attendance_plan` is the PLAN; `meeting_attendance` (`present | absent | excused`, **no row
= unmarked**) is the RECORD, and roll mode is now the only surface that writes it — the Minutes
card's recorder was deleted, so a second recorder is a regression, not a feature
(`absorbed-surfaces.guard.test.ts`). Which one you get is `panelMode = phase === "upcoming" ?
"plan" : "roll"`, one expression in `club.$clubId.meeting.$meetingId.tsx`; its visibility gate is
`effectiveCanManage && minutes.canEdit` rather than `runsThisMeeting`, so the TMOD arm above reaches
plan mode and NOT roll. Four things do not carry over
from the plan half of this section, and each is a place the symmetry misleads. **There is no single
seam and no store guard.** `buildRollPanel` (`src/lib/roll-panel.ts`) is a sibling of
`buildPlanPanel`, but on the server `meeting_attendance` is read and written from
`minutes-logic.ts` (`loadMinutes`, `setMemberPresence`, `addGuestPresent`, `removeGuestPresent`,
`assertAttendanceRecordable`) and NAMED by seven other `*-logic.ts` modules besides. Do not trust
that number: there is no `attendance-store.guard.test.ts` analogue to enforce it, which is the real
point — "add it to the seam rather than inlining a query" is advice about the PLAN table only, and
nothing fails if you inline one against the record.
**The derived `assumed` Coming does not reach roll.** `buildRollPanel` reads the raw rungs, so the
rail's inferred Coming produces no dashed `Present?`; deliberate for now, filed P1, and the one
place the two modes disagree about the same word. **The completed-meeting lock does not apply**:
`writesLocked = roll ? false : locked`, and `setAttendance`'s server gates are `gateAdmin` plus
`assertAttendanceRecordable` (has the DAY arrived) — never `status`. **Roll writes do not reach the server directly** — they go through the
offline write queue (`src/hooks/use-offline-minutes.ts`), which is the only channel while a queue
exists, so a new roll write added past `mutate` silently loses the ordering and deadline guarantees.
See CONTEXT.md's **Attendance / Presence** and **Offline write queue** entries, and ADR-0015's
amendment.

**Server modules must keep `pg` out of the client bundle.** A `src/server/*.ts` module that
defines a `createServerFn` gets imported by client route files; the Start compiler strips the
server-fn *handlers* (and their `#/db` imports) from the client bundle, but a plain top-level
db-touching export sitting in that same module is NOT stripped and drags `#/db` → `pg` →
`Buffer` into the browser (`ReferenceError: Buffer is not defined`, which white-screens the
page). So: **server-fn modules export only `createServerFn`s and types.** Put the directly
testable db logic in a sibling `*-logic.ts` (see `members-logic.ts`, `activity-feed-logic.ts`,
`club-logic.ts`) that client code never imports; the wrapper's handler calls it and gets
stripped. The `server-modules.guard.test.ts` unit test enforces this — it would have caught both
regressions.

The split has a SECOND, independent motive, and it is the one that usually applies: a
`createServerFn` cannot be invoked from a test (no session, no RPC layer), so a query living
only inside a handler is unreachable from vitest — it cannot be integration-tested, and a source
guard cannot hold a gate on something with no seam to gate. `club-logic.ts` (v1.12.0.0) was
extracted for that reason rather than for bundle safety: `loadClubMembers` / `loadMemberProfile`
put member email and phone on their payloads, and lifting them out is what let
`club-contact.integration.test.ts` reach them and let `club-contact-gate.guard.test.ts` require
every `club.ts` server fn that calls one to gate on `requireClubViewAccess`. Extract the
queries worth testing or guarding; leaving the rest inline is fine.

**A THIRD motive, and the one that bites quietly: a `-logic.ts` module imports `#/db`, so a PURE
helper inside one is unreachable by the client, and the client then grows a SECOND implementation
of it.** Nothing fails when that happens — the browser simply cannot import the module, so a
client needing the same answer writes its own way to get it and the two drift with every gate
green. `readImageDimensions` (the PNG/JPEG header parser) sat in `club-logo-logic.ts`, so
`club-settings.tsx` reached for `createImageBitmap` instead: a full decode, on the REJECT path,
costing 52.9 ms and 244 MB of renderer RSS on the 8000x8000 PNG the cap exists for, and a
different parser that could accept a file the server's would reject. #504 moved it to
`src/lib/image-dimensions.ts` (`Uint8Array`/`DataView`, imports nothing) and both sides call it.
So the rule is wider than "extract the queries worth testing": a helper in a `-logic.ts` module
that touches no db and that the client also needs belongs in `src/lib`, beside `club-archive.ts`
and `club-logo-url.ts`, which are the same move already made twice.

**Public `createServerFn` readers gate on `clubs.archived_at` themselves.** Archiving is the
platform takedown lever (ADR-0016 / ADR-0024) and it has **four** db-level enforcement points, not
one: `requireMembership` (`server/guards.ts`) covers authed WRITES; `grantView` in the same
file covers the authed READ gates `requireClubViewAccess` / `requireClubAdminView`, which resolve
their own memberships and never call `requireMembership`; `src/server/club-readable-logic.ts` —
`isReadableClub`, `isReadableClubForMeeting`, `isReadableClubForMember` — covers every public,
session-less one; and the three per-meeting agenda-write resolvers in
`server/meeting-authz-logic.ts` cover the agenda / Word-of-the-Day / ballot family, which resolves
its own grant ladder and reaches none of the other three (v1.26.0.0). A route guard is none of
them. `isClubArchived` (`src/lib/club-archive.ts`) holds
the canonical list; this paragraph points at it rather than being a second copy. This line read
"`requireMembership` covers every authed path" until #560, and that sentence is exactly why 24 gated
readers kept serving an archived club's roster contact details to its own signed-in members: the
claim was checkable in one place and false in another, so nobody re-derived it. There is **no
impersonation exemption** on the read gates: `grantView` asserts the archive state for every arm, so
a read-only session reads an archived club no more than the club's own members do, and
`requireSuperadmin` (the console) stays the way to inspect one. An exemption was written into #560
and dropped, for two reasons worth keeping: the console already hides "View as this club" for an
archived club, so it was unreachable in the direction it was meant for, and because the member arm
returns first it was silently overridden for an operator who also held a plain membership — which
made the two gates answer OPPOSITELY for one person. The
`/club/$clubId` shell's `beforeLoad` → `resolveClubOrRedirect` guards the **caller**, while a
server fn is addressable directly with no session and no router; reading the shell as coverage is
what left fourteen public readers serving an archived club's roster, agenda and live ballot until
#544. Each gated seam returns its own not-found shape (`null` for a row, `[]` for a list) rather
than throwing, so an archived club is indistinguishable from one that never existed and no call
site needs new error handling. Gated seams carry `Public` in the NAME
(`loadPublicClubRoster`, `loadPublicUpcomingMeetings`, `resolvePublicMeetingKey`,
`resolvePublicClubIdentifier`, …): the gated and ungated siblings have identical signatures, so the
name is the only signal that does not require opening the body, and an inline query in a handler
must be lifted into a `*-logic.ts` seam before it can be gated *and* tested — a handler body is
unreachable from vitest. `public-readers-archive-gate.guard.test.ts` **derives** its candidate set
by walking `src/server/*.ts` and treating any `createServerFn` whose body calls no `require*` guard
as anonymous, so the next public reader is enrolled automatically rather than remembered: it must
be wired to a gated seam or waived in `REVIEWED_UNGATED` with a stated reason.

**Reads are closed at every point, but the enrollment sweep is not.** The public readers gate
(#544), the two authed READ gates gate (#560), and so do the authed readers that reach NO point at
all because they resolve membership with a bare `getMembership`: `minutes.ts` and
`api/meetings.$id.minutes.pdf.ts` call `isReadableClub` directly, and `my-activity-logic.ts` inlines
the same `archived_at` predicate into `loadMyCommitments`' query (#560) — a reader that funnels
through none of those points cannot be covered by fixing one of them. The service worker evicts a
taken-down club's pages and crest on a 404/410 (#556).

**WRITES are closed too, since #555, and they close differently from reads.** A read collapses an
archived club into not-found; a write THROWS, because every write already has an error path to its
caller and silently accepting one that will never be readable is worse than saying the club is gone.
`assertClubNotArchived` (exported from `guards.ts`) is the call, and the message lives in
`#/lib/club-archive` as `CLUB_ARCHIVED_MESSAGE` so the two callers that cannot use the assert still
raise the same sentence. The first is `applySelfAdd`, and the exception is the interesting part:
it reads `archived_at` inside its own pre-existing `FOR UPDATE` lock instead, because a pre-check is
check-then-act and this is the path that mints a `people` row PLUS a `members` row — the race would
leave exactly the PII the takedown was meant to stop collecting. Where a write already holds a club
lock, gate inside it; everywhere else the assert is right. The second arrived in v1.26.0.0: the
per-meeting agenda-write resolvers read `archived_at` in a private
`assertMeetingClubNotArchived`, because `guards.ts` imports `meeting-authz-logic.ts` and calling
the assert back would close an import cycle. Five of the seven session-less writes gate
in a `-logic` SEAM rather than in the handler, which is not stylistic: a handler body is unreachable
from vitest, so a handler-gated write is covered by a source grep and nothing else. (It read "six of
the eight" until v1.26.0.0; #616 admin-gated `addMember`, which took it out of the session-less set
entirely. `WRITE_GATES` in `public-readers-archive-gate.guard.test.ts` is the list — count there.)
`releaseSlot`/`updateSpeakerDetails` are the two still in that position (their logic is inline in
`slots.ts`), recorded in `TODOS/legacy-2026-09.md`.

**The enrollment sweep is now closed on both shapes**, having been closed on neither. The
`\n});` body-slicing bug is fixed (#565) and `bodyStopsAtItsOwnDeclaration` fails on any
recurrence — do not re-add that claim, it was true only before #565 and this paragraph asserted it
for a release afterwards. The second half was real until #555: the sweep walked `src/server/*.ts`
for `createServerFn` and nothing at all enrolled `src/routes/api/**`, which serves club content
through `createFileRoute` + `server.handlers` and matches none of those patterns. Four endpoints
lived there, three gated by hand, and the fourth — the Pathways ingest — was not: a live per-club
Bearer token could keep writing member names, paths and project completions into a taken-down club,
answering 200 the whole time. It now 410s (the token is valid; the club is finished), and the API
sweep is RECURSIVE because the one broken endpoint was a directory down.

**The takedown now reaches copies already handed out, and a caching header is what stopped it.**
The logo route answered `max-age=31536000, immutable` for a current `?v=` URL, so a crest fetched
the day before an archive kept rendering for up to a year (#517). Worse than that framing: `immutable`
also **disabled #556's eviction**, because the service worker revalidates with a plain `fetch`, which
the browser's own HTTP cache satisfies — so `response.ok` stayed true and `isGoneResponse` could
never fire. The one mechanism built to reach cached copies was switched off by a header, silently,
in the direction that looks fine. `immutable` bought bytes and not correctness in the first place:
the `?v=<updatedAt>` cache-buster already handled REPLACEMENT.

Three rules that came out of it, worth keeping if you touch any cached public surface. Bound
`max-age` and pair it with an `ETag`, so revalidation is what enforces the takedown and the ETag is
what makes it cheap — the conditional path resolves through `loadClubLogoMeta`, which cannot select
`bytes`. Gate the 304 with the SAME archive check as the byte path: an unguarded 304 renews a
taken-down crest's lease forever, one round trip at a time, which is a worse failure than the year
it replaced. And a service worker's background revalidation needs `cache: "no-cache"` to see an
origin 404 at all — scoped to the crest, since the rest of that cache is hashed build output whose
URL changes every deploy and can never go stale.

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

**Do NOT use `npx codeledger`** — the unscoped `codeledger` name on npm is an unrelated third-party package, not this tool. Use `npx @codeledger/cli` if you need `npx`.

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
