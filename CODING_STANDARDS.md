# Coding standards

Read at REVIEW time. `/review-pr`'s Standards axis reads this file and holds a diff to it; the
implementer meets these rules as failing guard tests first and as this file second. It was carved
out of CLAUDE.md on 2026-09-05 so that ~42KB of review-time material stops riding in every agent's
context on every turn. The text is MOVED, not rewritten: a code comment that cites "CLAUDE.md's
Test Coverage traps", or a CLAUDE.md paragraph by name, means the same paragraph here. Rules in
this file override the smell baseline the code-review skill carries.

## Test coverage

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

## Conventions

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
`#/lib/club-archive` as `CLUB_ARCHIVED_MESSAGE` so a caller that cannot use the assert still raises
the same sentence. One such caller exists today, and it arrived in v1.26.0.0: the per-meeting
agenda-write resolvers read `archived_at` in a private `assertMeetingClubNotArchived`, because
`guards.ts` imports `meeting-authz-logic.ts` and calling the assert back would close an import
cycle. Five of the seven session-less writes gate
in a `-logic` SEAM rather than in the handler, which is not stylistic: a handler body is unreachable
from vitest, so a handler-gated write is covered by a source grep and nothing else. (It read "six of
the eight" until v1.26.0.0; #616 admin-gated `addMember`, which took it out of the session-less set
entirely, and #630 deleted it. `WRITE_GATES` in `public-readers-archive-gate.guard.test.ts` is the
list — count there.)
`releaseSlot`/`updateSpeakerDetails` are the two still in that position (their logic is inline in
`slots.ts`), recorded in `TODOS/legacy-2026-09.md`.

**Where a write already holds a club lock, gate INSIDE it; everywhere else the assert is right.**
This rule has no live instance as of #630, and it is stated here rather than dropped because the
reasoning does not depend on the function that demonstrated it. That function was `applySelfAdd`,
the anonymous "I'm new — add me" roster self-add. It took a `FOR UPDATE` on the club row for its
throttle, and #555 read `archived_at` out of that same locked row instead of calling
`assertClubNotArchived` before the transaction. The placement was the whole point: a pre-check is
check-then-act, so a club archived between the check and the insert still gets the rows, and that
path minted a `people` row PLUS a `members` row — the race would have left exactly the PII the
takedown was meant to stop collecting. Reading `archived_at` inside the lock answered both
questions against one row version and cost no extra round trip, because the statement was already
there. #616 admin-gated the only caller and #630 deleted both.

Do NOT repoint that example at a surviving session-less writer without checking, because the
obvious candidate does the opposite. `captureGuestVisit` calls `assertClubNotArchived` FIRST, before
its transaction, and then takes `SELECT id FROM clubs … FOR UPDATE` inside it for the guest-book
throttle — a lock it could gate in, on a path that mints a `guests` row carrying a name, an email
and a phone. So it is a pre-check with a lock available, which is the shape this rule argues
against, and it is the one place the rule would still apply if someone moved the check. That has
not been done and is not a #630 regression: it is how #555 shipped it. It is parked in
`TODOS/remove-self-add-630.md` rather than filed, because the window is a few milliseconds wide on
a superadmin takedown and the residual row is a guest in a club every read already reports as
gone — but a reader looking for the worked example should find this note instead of assuming the
guest book is one.

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

