# Commands, in full

Moved verbatim out of `CLAUDE.md` on 2026-10-05 so it stops riding in every session's and every subagent's context on every call (see `docs/agents/token-usage.md`). A code comment citing a CLAUDE.md paragraph by name means the same paragraph here.

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
- `bun run test:hydration` — only the route hydration gate (#1000) and its teardown test, what CI's
  `hydration` job runs (#1022). A plain `bun run test` includes them too; `check` leaves them out
  with `EXCLUDE_ROUTE_HYDRATION_GATE=1`, the one value `vitest.config.ts` honours.
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
  actually conflict. It also serialises an issue labelled `migration`. **That label exists** and is
  in the vocabulary below; this line used to say it did not, which is why the `drizzle/` path
  signal was built first and why the label half went unused after it landed. Prefer the LABEL: a
  cited `drizzle/` path only fires once the migration is written, so it never fires on the issue
  that merely proposes one — exactly the issue a wave needs held back. The CLI still reports when
  no OPEN issue carries the label, because a serialisation that never fires looks like a backlog
  with no migrations in it.
  **The change set is read from a heading that is exactly `## Files`** — `issue-batching.ts:254`
  matches `/^#{1,6}\s+Files\s*$/` and nothing else. So `## Files Reference`, which is what
  gstack `/spec`'s own issue template prescribes, contributes NOTHING: the batcher falls back to
  scanning the whole body for path-shaped strings, and the waves get built from prose mentions
  rather than the declared change set. Nothing errors and the plan still looks plausible, so after
  filing check the issue appears under `bun run batch:issues` with the files you meant.
- Run a single test with `bunx vitest run <path>` (or `bunx vitest <path>` to watch).
- `bun run mutate <file> --literal <old> <new> <label> <test-path…>` — **the** way to
  mutation-check a test (reintroduce the bug, confirm it goes red). Do not improvise it with
  `sed` + `git checkout`: that wiped uncommitted fixes at least four times (the last was #831), and
  BSD `sed` no-ops silently, so an unapplied mutation read as a kill. The script restores from a
  copy, works on a file with uncommitted edits, requires `<old>` to match exactly once, and refuses a
  baseline that collected no tests. Its header lists what each guard exists for. Paths are
  repo-root-relative under `bun run` (Bun drops the caller's directory); `scripts/mutate.sh`
  called directly takes them relative to wherever you are.

**A suite that seeds a CLUB-LESS row must clean it up itself, and must not use a fixed key.**
`cleanup(clubId, userIds)` cascades from the club, so anything with a null `club_id` — a global
`meeting_templates` row is the first — survives it and leaks into the next run. Three further
traps, all hit for real: `cleanup` takes ARGUMENTS, so `afterEach(cleanup)` hands it vitest's
context and silently deletes nothing; vitest runs test FILES in parallel against one shared
`tm_test`, so a fixed global key collides across suites and an unscoped `delete(table)` takes
the other file's in-flight rows; and any assertion over an unscoped `select()` on a shared
table is order-dependent by construction. Give seeded keys and names a per-run suffix, track
the ids you created, delete only those, and scope every assertion to your own club.

**Integration suites need a database or they silently SKIP.** In a worktree bootstrapped by
`worktree:setup`, `src/test/setup-env.ts` reads the worktree's own database from `.env.test.local`,
so a plain `bun run test` runs them — export nothing there, because an exported
`TEST_DATABASE_URL` wins (that is how CI's applies) and would put the run back on the shared
`tm_test`. If setup warned it could not create the database, fix that and re-run setup. Only in
the main checkout export `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` before
`bun run test`, or ~630 tests vanish from the run and the pass count still reads green; there, a
plain `bun run test` masks stale assertions that CI catches. `tm_test` is push-synced, so after a schema change run
`DATABASE_URL=…tm_test bun run db:push --force` — test databases are the one thing `db:push` is
for. A worktree's own database is re-synced by re-running `bun run worktree:setup`.

**The browser-backed suites need Chrome — set `CHROME_PATH` to run them on a Mac.** There are 21 of
them as of #1022, every test file carrying the `CI has no Chrome` refusal
(`grep -rl 'CI has no Chrome' src`): 19 run in CI's `check` job and the route hydration gate's two
run in `hydration`. The twelve described below are the ones with a lesson attached, not the full set.
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

`src/components/agenda/slide-fit-geometry.test.ts` (#767) is the fifth: it renders a projected
slide's body box and asserts a shrunk body lands inside it rather than behind the footer. Same
split — `fitScale` (`src/lib/slide-fit.ts`) is the seam, the box's padding comes from the
`slide-spacing` constants, a pre-fix control overflows beside it, and a source guard pins that
`useFitTransform` actually calls it.

`src/components/agenda/splash-logo-geometry.test.ts` (#725) is the sixth, and it is the one that
gates a proportion shared by TWO renderers. The club's mark on a splash is sized from
`SPLASH_LOGO_HEIGHT_PCT` / `SPLASH_LOGO_MAX_WIDTH_PCT` / `SPLASH_RULE_WIDTH_PCT`
(`src/lib/slide-layout.ts`), read as `cqw()` on screen and `inchesOfWidth()` in the `.pptx` — and
the ceiling's own sentence is "no wider than the rule beneath it", which is a claim about
GEOMETRY, not about a number. #725 shipped it asserted as a literal and it was true on screen and
false in the export, where the rule was a hard-coded 45% against the mark's 58%, so a wide
wordmark overhung its own rule by 0.87in a side in the downloaded deck with every gate green. Both
halves now measure the RENDERED rule — this suite on screen, `deck-to-pptx.test.ts` in the export
— and each bounds the white plate's overhang by that renderer's own padding, so the two surfaces
state one rule in their own units. The lesson is the general one: when a constant is shared by two
renderers, assert it against what each RENDERS, because a literal restated in the test agrees with
whichever renderer the author had in mind.

`src/components/agenda/ballot-qr-print-fit.test.tsx` (#717) is the seventh, and it is the one that
says why a ceiling is not a floor. The bug is a printed ballot QR too SMALL to scan; the regression
that fixing it can ship is a sheet too TALL to stay on one page — so it bounds BOTH directions, and
states the floor as an absolute printed number rather than against `FOOTER_QR_PX`. Its own first
draft did the latter, and a bound expressed against the constant under test gets LOOSER as that
constant shrinks: `FitPage` scales the sheet by `(PAGE_H - 2) / height`, so a smaller code means a
shorter sheet means more slack. Putting the constant back to the 32px #717 was filed about left
every assertion in the two print suites beside it green — blind to precisely the regression it was
written for. Mutate a size constant in BOTH directions, and never state a bound in terms of the
number it exists to constrain.

`src/components/guest-book/confirm-table-geometry.test.ts` (#806) is the eighth, and it is the
pinned-column lesson on the other axis. Six columns do not fit the 375px phone an officer actually
transcribes a guest book on, and a too-wide table either scrolls its own BOX or scrolls the
DOCUMENT — and the second slides the heading, the summary counts and the "Record this page" button
off the screen along with it. `overflow-x-auto` being PRESENT is the half that is not the bug: a
scroller whose child has no `min-w` floor never overflows, and one inside a parent with no width
constraint hands the overflow to the document instead. Both satisfy every grep, and only a browser
tells them apart. Same construction as its neighbours — the real `className` strings read out of
source, synthetic markup between them, and a pre-fix control that reproduces the bug.

The ninth, tenth and eleventh are the marketing flyer's (#931), and between them they cover the
two ways a fixed-size surface fails silently. `src/components/agenda/meeting-flyer.test.tsx` is the
Letter poster: one printed page beside an empty-document control, plus the natural height with
EVERY free-text field at its cap measured against `MIN_FIT_SCALE` — the page count alone reports 1
for a poster `FitPage` would flow onto a second sheet, because static markup never runs its effect.
`src/components/agenda/flyer-square-geometry.test.tsx` is the square image: a fixed 1080px box with
`overflow: hidden`, so capped copy clips whatever falls below it, and what must never be clipped is
the QR and the ADR-0024 disclaimer. It measures both boxes at the caps, and because the layout has
TWO guards (the text block gives way, and every field is line-clamped) it strips each from the
shipped markup in turn and asserts the other holds alone — so reverting either one in source goes
red instead of being masked — with a both-stripped control that must overflow.
`src/components/agenda/flyer-square-png.test.tsx` runs the SHIPPED `exportSquarePng`
(`html-to-image`, bundled from source with esbuild) in Chrome and decodes the PNG it produces: the
QR decodes to the meeting URL and the logo region is not blank, beside a no-logo control and a
not-inlined logo that must be refused. It is the one harness here that drives Chrome over the
DevTools protocol (`--remote-debugging-pipe`) and awaits a promise, rather than `--dump-dom`: the
dump flaked ~1 run in 3, because virtual time fast-forwards while an image decodes off the main
thread and Chrome dumped the page before the export finished, at any budget. Reach for the pipe
whenever the thing under test is asynchronous work the page does not look busy doing.

`src/components/agenda/print-screen-fit-geometry.test.tsx` (#964) is the twelfth: at 375px every
agenda layout and the landscape poster must sit on screen with no sideways scroll or blank band,
`FitPage` must measure the same height as on a desktop, and 820, 848 and 1280px must match the
pre-fix control exactly. Pages load in a 375px IFRAME because headless Chrome will not size a window
below 500px. `SCREEN_FIT_CSS` is a `transform`, not `zoom`, because `zoom` reflows the text `FitPage`
measures and a phone would print a smaller page. `print-screen-fit.test.tsx` (jsdom) is its
companion, checking the component writes the `--sheet-w` / `--sheet-h` the geometry cases assume.

The flyer suites also added test-only dependencies (`jsqr`, `pngjs`); everything below about Chrome itself still
holds. No new dependency for Chrome: the harness (`src/test/print-page-count.ts`) runs `$CHROME_PATH` if set, else
`google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser`, whichever runs first.
With none present those tests **skip locally**, so `bun run test` still works for someone without a
browser; **in CI they fail** instead (`CI has no Chrome on PATH`), because a silently absent
geometry gate reads exactly like a passing one — the same failure shape as the DB-backed suites above.
`ubuntu-latest` ships Chrome, so CI needs no install step; the dependency is named in
`.github/workflows/ci.yml` beside the `check` job's `Test` step so a runner-image change is
diagnosable. Beside that job's ONLY — the `extension` job is `working-directory: extension` and
runs the sub-package's own three-file vitest, which touches no browser. It carried a copy of the
same Chrome comment until v1.22.8.0, naming suites that working directory cannot see.

**The route hydration gate (#1000, `src/routes/route-hydration.test.ts`) is browser-backed too, but
it runs in its OWN CI job, `hydration`, in parallel with `check` (#1022).** It starts a vite dev
server and sweeps every route in Chrome, ~4.5 minutes of one file, which is work `check` no longer
carries. (How much WALL time that saves `check` sits inside its run-to-run noise: its duration
ranged 493-777s over six runs on 2026-09-28, with and without the gate.) `check`'s `Test` step sets
`EXCLUDE_ROUTE_HYDRATION_GATE: "1"`, and `vitest.config.ts` (`excludesHydrationGate`) drops the
gate and its teardown test (`HYDRATION_GATE_FILES`) on exactly that value and no other; the
`hydration` job runs `bun run test:hydration` (exactly those two files) and then fails if the JSON
report shows zero tests, any skipped, or the sweep test not passed. A plain local `bun run test`
sets nothing, so it still runs the gate. `hydration-gate-ci.guard.test.ts` PARSES the workflow (so a
commented-out line cannot satisfy it) and holds the file list, the script, the variable's name and
value, and the `hydration` job's shape (no `if:`, no `continue-on-error`) to each other: one
drifting would run the gate nowhere with every job green.
Both jobs need Postgres and Chrome, and the gate itself still fails rather than skips in CI without
either.

**On macOS every one of them skips unless you set `CHROME_PATH`**, because Chrome installs as an `.app` and
puts nothing on `PATH` under any of those four binary names — that is the `CHROME_BINARIES`
lookup list, which is still four, and not the suite count above. This is a macOS-only gap: on Linux, where this
repo is usually developed, `google-chrome` resolves and these gates run locally as normal. Do NOT
"fix" it by hardcoding `/Applications/Google Chrome.app/...` in `CHROME_BINARIES` — that binary
answers `--version`, so `findChrome` accepts it, but it never returns from `--print-to-pdf` under the
agent sandbox, which turns an honest skip into 135s of `ETIMEDOUT`. A browser that is found but hangs
is worse than one that is not found. A Playwright `chrome-headless-shell` works and returns in ~0.2s:

```bash
CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell" bun run test
```

Numbers measured through this harness are NOT comparable to the deployed page: it runs with
`--host-resolver-rules=MAP * ~NOTFOUND`, so Fraunces and Manrope never load and the platform's
substitute has its own metrics. That is why the point floors in `src/lib/agenda-print-type.ts` carry
a wide margin and the exact declared sizes are pinned by a separate assertion.

**Which substitute it is was the MACHINE's answer, not the repo's, until #813's follow-up.** A stock Ubuntu
desktop resolves the sans stack to Noto Sans and CI's `ubuntu-latest` to DejaVu Sans, and that alone
moved the editorial agenda's fit scale from 0.7239 to 0.71603 against `MIN_FIT_SCALE` of 0.72 — so
`print-density.test.tsx` and `ballot-qr-print-fit.test.tsx` failed on a developer's machine and
passed in CI on identical code, for months. A gate that CI calls green teaches everyone to ignore
it, and these are the only gates here that see print at all. `src/test/print-fonts.conf` now pins
the fallback and `print-page-count.ts` sets it as `FONTCONFIG_FILE` on every Chrome it launches
(`CHROME_ENV`, which the other two browser harnesses import). Three things worth knowing:

- **It redirects `system-ui`, not the CSS generic.** The stack is
  `'Manrope', ui-sans-serif, system-ui, sans-serif` and `system-ui` is the family that resolves;
  prepending to fontconfig's `sans-serif` pattern is what moves it. A box declaring `sans-serif`
  alone measures 739 whatever the rule says. There is deliberately no serif rule — the same
  prepend leaves the serif stack at 694 whichever face it names, so one would be decoration.
- **A malformed conf fails SILENTLY.** XML forbids a doubled hyphen inside a comment, and
  fontconfig answers an unparseable file by discarding it whole and falling back. Every wrapper
  still looks healthy: the path resolves, the file exists, Chrome starts, and only the numbers
  disagree. `src/test/print-fonts.test.ts` measures the resulting face (940 pinned, 828 on Noto
  Sans) so that shows up as one named red test.
- **Linux only.** macOS Chrome uses CoreText and ignores fontconfig, so there the variable is
  still present and the canary is what says so.

**Read the lint gate with `--diagnostic-level=error`.** `src/db/seed.ts` carries ~118 pre-existing
`noNonNullAssertion` warnings, which Biome does not fail on, so the tail of a `bun run check` run is
a wall of noise and a single real error scrolls past. `bunx biome check --diagnostic-level=error` is
the readable view. Run the gate LAST, before commit, with CI's bare invocation — `biome check src/`
skips files a bare run includes.
