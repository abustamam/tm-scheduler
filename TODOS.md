# TODOS

> **GitHub issues are the canonical tracker** (`abustamam/tm-scheduler`, managed via `gh`). See `docs/agents/issue-tracker.md`.
>
> This file is for in-flight work that is not worth an issue yet: follow-ups noticed mid-branch, deferred pieces of something currently being built. Anything that outlives the branch it was noticed on should become an issue, and the entry here should be deleted rather than mirrored.
>
> Format: group under `## <Component>`, one `**Priority:**` (P0-P4) per item, completed items move to `## Completed` with the version that shipped them. `/ship` reads this file and moves items itself when the diff shows the work is done.

## Meetings

- An ex-member can still see a departed club's forward schedule. `userMemberIds` deliberately ignores `members.status`, and the deactivation sweep in `members-logic.ts` skips slots on CANCELLED meetings, while `applyReopenMeeting` restores a meeting without clearing assignments. Cancel a meeting, deactivate a member, reopen it, and their `/me` shows that club's date, theme and location with a Release button that dead-ends. Needs all three steps, so it is debt rather than scheduled work.
  **Priority:** P4

## Contact links

- Run `scripts/backfill-phone-e164.ts` against prod. Deferred from v1.12.0.0 by design — it writes to the production database, and the plan marks all four steps human-run. Not urgent: read-time coalescing already makes every rendered link correct, so this buys the #397 guest-collision report and stored-data hygiene rather than working links. Dry run first and **confirm the printed `host=` line is the Railway host** — `set -a; . ./.env.prod.local` is a zsh parse error on the connection string's unquoted `&`, so `DATABASE_URL` never gets set and Bun silently falls back to `.env.local`, running the whole thing against dev. Pass it inline instead. Then review the guest-collision report (those rows need a human merge; the script only reports them), apply, and re-run expecting `Would change 0 of N rows`.
  **Priority:** P1

- `/activity` fetches every member's phone to populate a filter dropdown that reads only `id` and `name`. Same auth gate as before, so not an exposure, but it serializes the phone into the SSR payload of a page that never renders it and makes that route pay a country-code round-trip for a field it discards. A narrow `listClubMemberNames` loader would drop both.
  **Priority:** P4

- The `no-tel-links` guard forbids `href="tel:"`, but the decision it enforces is "every rendered phone opens WhatsApp". A future surface doing `<span>{member.phone}</span>` passes the guard, every render test, and review. No present defect — swept the tree at v1.12.0.0 and the only remaining `phone` references are form inputs and the nudge picker's null check — but the guard enforces the narrower half.
  **Priority:** P4

- The SSR mount-gate dance (`useState(false)` + `useEffect` + `detectPlatform(navigator)`) is duplicated between `whatsapp-phone-link.tsx` and `nudge-buttons.tsx`, including the `"mobile"` default that has to match the server render. A shared `usePlatform()` in `#/lib/platform` would give that reasoning one home. Deliberately not done at v1.12.0.0: measured at 5.4ms over 200 rows in jsdom, and hoisting `mounted` to the list re-renders the whole table instead of the leaves, so it is a readability change, not an optimization.
  **Priority:** P4

## Archive takedown

Surfaced by the `/review` passes on #560/#556 and deliberately left out of that branch.

- The enrollment sweep walks `src/server/*.ts` only, so **`src/routes/api/**` is enrolled by
  nothing**. That is the other half of #565: the minutes-PDF route was an ungated authed GET URL
  serving an archived club's minutes, while its sibling `api/meetings.$id.role-sheets.$sheet.pdf.ts`
  one directory entry over called `isReadableClub` correctly. Both are gated now, but only by a
  hand-written case in `minutes-authz.guard.test.ts` — the next binary/export route added under
  `src/routes/api/` is caught by no derived check. Extending the walk needs a different body-slicer
  (route handlers are `server: { handlers: { GET: … } }`, not `export const x = createServerFn`),
  which is why it did not ride along with the slicer fix.
  **Priority:** P2

- #556's eviction rests on an assumption nothing gates: that a `notFound()` in a route loader keeps
  mapping to an HTTP **404**. Verified by hand against a dev server while writing the fix (meeting
  page and `/present` 404; `/print` 307s to `?layout=grid` which 404s; the logo endpoint 404s), and
  noted in `isGoneResponse` — but every sw test INJECTS the status, so they stay green either way.
  If a TanStack Start upgrade made that a 200, `response.ok` flips true, the not-found page is
  CACHED over the agenda, and the eviction silently never runs. A real gate needs an HTTP-level
  assertion against a booted server, which this repo has no harness for.
  **Priority:** P3

- Archiving now has three different wire contracts for one domain event: `resolveClubOrRedirect`
  throws `notFound()`, the public readers return `null`/`[]`, and the authed gates throw a raw
  `Error` that crosses the RPC boundary as a 500-class rejection. `router.tsx` sets
  `defaultNotFoundComponent` but no `defaultErrorComponent`, so a loader that reaches the throw
  renders TanStack's unstyled "Something went wrong!" outside the app chrome. Narrow today — the
  `/club/$clubId` shell 404s first for routes under it — so it bites routes that call a gated fn for
  a club id without going through that shell, and only for a club archived mid-session. Pre-existing
  in shape (`requireMembership` has thrown this since #186); #560 widened it from writes to reads.
  **Priority:** P4

## Tooling

- `bun run fix` writes the whole tree, and there is no scoped variant. Fine today (it is a verified no-op on a clean tree), but two things make a scoped one worth having before anyone wires it into a hook: `biome check --changed` hard-errors here because `biome.json`'s `vcs` block has no `defaultBranch`, and a `pre-commit` hook running the unscoped `fix` would sweep unrelated working-tree drift into the commit. `--staged` is verified working, so `"fix:staged": "biome check --write --staged"` plus `"defaultBranch": "main"` in the `vcs` block would close both.
  **Priority:** P4

- Biome's `files.includes` covers `src/**`, `.vscode/**`, `index.html` and `vite.config.ts` only, so `scripts/**`, `drizzle.config.ts`, `vitest.config.ts` and the whole `extension/` sub-package are outside the gate entirely. `extension/` has no Biome config and no Biome step in its CI job, yet some plans instruct running Biome from inside it, where it resolves the root config that excludes those paths. Decide whether those paths should be linted or explicitly declared out of scope.
  **Priority:** P4

## Agenda

- Confirm the hand-off rows on a real MCF agenda after it deploys — that the four print layouts read right in the room and the projected deck's hand-off slides land where the cue is needed. v1.16.1.0 (#585) made those rows name the people too, so this now also covers whether the longer rows read well at the printed size.
  **Priority:** P3

- Neither `meeting-present.tsx` nor `deck-to-pptx.ts` renders a hand-off slide in any test, so the projected cue line — now the longest single line on those slides after #585 — is unasserted in both renderers. `slide-layout.test.ts` pins the descriptor the two of them consume, which is why this is P4 rather than a gap in the fix itself.
  **Priority:** P4

- `scripts/measure-word-poster.ts` has no tests because `main()` runs at import, so nothing is reachable. It is the harness that derives the Word of the Day poster's font-size tables, and a wrong result there ships mid-word breaks on a wall poster. `scripts/import-agendas-logic.ts` is the repo's precedent for extracting a testable `*-logic.ts` alongside an entry-point script.
  **Priority:** P4

## Testing

- Two integration suites hand-copy queries that #544 turned into reachable seams, so they now assert against copies that can never fail when production changes. `public-reads.integration.test.ts` has `listUpcomingMeetingsPublic` (a verbatim mirror of what is now `loadPublicUpcomingMeetings`) and `getMeetingPublic` (a mirror of `loadMeetingDetail`); `member-status.integration.test.ts` has `listActiveMembers` (a mirror of what is now `loadPublicClubRoster`). The first two are the repo's "a parity test cannot see a defect present on both sides" trap with the twist that only one side is production code — and the mirrors carry no archive gate, so they have already diverged. Both files already `vi.mock("#/db")`, so re-pointing them at the real seams is a small edit. `getMeetingPublic` cannot be re-pointed until `loadMeetingDetail` is exported from a `*-logic` module.
  **Priority:** P3

- `seedPhone` in `src/db/seed.ts` cannot be tested. `seed.ts` imports `#/db` at module load AND calls `main()` unconditionally at the bottom, so importing it from vitest throws before any assertion runs — the CLAUDE.md "a constant in a module that imports `#/db` at load is unassertable" corollary, applied to a formatting helper instead of a numeric cap. Nothing exercises the E.164 shape or the determinism the function promises, so a change that produced a duplicate or a malformed number would be invisible until someone noticed drafts failing. Fix is the pattern CLAUDE.md already prescribes: move `seedPhone` into `src/lib/` and let the seed import it. Surfaced by the v1.16.0.0 coverage audit.
  **Priority:** P4

- Two `#576` behaviours are reachable only from a real browser, and both are the kind a source guard pins as TEXT while never executing. (1) `tmodPanelUnavailable` — the guard proves the expression and the JSX ternary exist, but nothing observes that a pending or errored query actually suppresses the panel, which is the whole point of it (an empty roster otherwise renders a header and a counts line of zeros, indistinguishable from "no members"). (2) `resolveActor`'s arms — the write-side TMOD comparison, the `OFFICER_DENIALS` catch-and-fallthrough, and the self arm's throw are all private to a `createServerFn` module, so vitest cannot invoke any of them; the read-side twin (`loadTmodPanelData`) IS executed and covers the equivalent decision, but the write path's own resolution never runs. Both need an HTTP-level or browser test, which this repo has no seam for yet. Accepted for v1.16.0.0 rather than hidden: the guards pin the shape, and the /qa pass drove both paths by hand.
  **Priority:** P3

- **Roll call costs one full route-loader round trip per tap.** Every roll-mode write resolves
  online through `useOfflineMinutes.mutate` → `onMutated` → `router.invalidate()`
  (`src/routes/club.$clubId.meeting.$meetingId.tsx:303`), which re-runs the WHOLE meeting loader:
  `loadMeetingDetail` alone issues ~15 sequential DB round trips, plus `listPastMeetings`,
  `listUpcomingMeetings`, `getMinutes` and `getClubLogoMeta` — roughly two dozen sequential
  queries to persist one member's present/absent/excused. `mutate` awaits it INSIDE the `busy`
  window, and since the /review fix the panel correctly disables every chip for that whole
  window, so an officer tapping down a 20-40 name roster at conversational pace lands a large
  fraction of taps on a disabled control. Found independently by the performance specialist and
  the adversarial pass on the v1.16.0.0→PR3 review, at confidence 9.
  Plan mode does NOT have this problem: it applies a local `rungOverride` optimistic update, so
  its taps feel instant. Roll mode is inconsistent with its own sibling, which is why this reads
  as a gap rather than an inherent cost. The shape that works is per-row optimistic state plus a
  serialized single-flight writer (accept every tap, apply locally, drain in order) rather than a
  global refuse-and-disable. Deliberately NOT fixed in the review round: it is an optimisation of
  a path that works, and the right shape needs measuring against a real club payload first.
  **Measure `router.invalidate()` against a real club before choosing.**
  **Priority:** P1

- **The roll-mode suggestion chip may not be distinguishable from a recorded one.** D3's whole
  premise is that a member with a plan but no recorded row renders a dashed "Present?" that commits
  in one tap — but the only visual differentiator is `className="border-dashed"` on a
  `variant="outline"` Button (`meeting-attendance-panel.tsx:140`), and `outline`'s border is
  `--border: var(--line)` = `rgba(23,58,64,0.14)` light / `rgba(141,229,219,0.18)` dark
  (`src/styles.css:22,101`) — a 1px line at ~15% opacity. Dashed vs solid at that opacity will not
  read at arm's length, and nothing else differs: no fill, no background tint, no icon. The
  trailing `?` is the only other cue and it requires READING each label rather than
  pattern-matching the row, which is the failure mode the design exists to avoid. If an officer
  cannot tell guesses from records at a glance, the counts they read out to the club are wrong.
  Fix: give the suggestion state a fill or background tint (or a coloured left bar) on top of the
  dashed outline. Design specialist, confidence 8, on the PR-3 review.
  Nothing in this repo can gate it — jsdom performs no layout, so no test can see it.
  **Priority:** P1

- **A captive portal's 200 HTML login page makes a roll tap read as SUCCESS and vanish.** Found
  while investigating whether the offline queue can tell a transport failure from a server-chosen
  one (the /ship-halt round's F5). Three flavours, and the third is the bad one:
  1. A `fetch` rejection is rethrown unchanged, so it arrives as a bare `TypeError`.
  2. `instanceof TypeError` is NOT a usable discriminator: seroval reconstructs a *server-thrown*
     `TypeError` as a `TypeError` too (fixed constructor table), so classifying on it would
     queue-and-replay-forever on any server bug — the stuck queue the current comment exists to
     avoid. A naive class-based fix is WRONG, not merely partial.
  3. **Two of the three portal shapes never reach that catch at all.** A portal's 200
     `text/html` login page falls through to `return response`, so the write currently reads as
     success, the chip moves, nothing is queued, and the roll entry is silently lost — on the
     exact network this feature exists for.
  The reliable seam is TanStack Start's `CustomFetch` (`createStart({ serverFns: { fetch } })`),
  which this repo does not configure at all. That is where a transport-vs-server classification
  belongs, and it would fix all three flavours at once.
  **Priority:** P1

- Smaller residue from the same review, none blocking: plan mode's `DropdownMenuItem`s are
  ungated where roll mode's are now gated (`meeting-attendance-panel.tsx:100-106`; `writeRung` has
  no `writesLocked` precondition while its sibling `contacted` does); `RollAttendanceRow` and
  `AttendanceRow` duplicate the same row shell; `projectMinutes` (`src/lib/roll-attendance.ts:47`)
  hand-copies the online/offline branch from `meeting-minutes.tsx` and its own comment concedes a
  comment enforces nothing — extract one shared `projectOfflineMinutes` so drift becomes
  compiler-visible; the roll chips' `aria-label` is `"<name> status"`, which REPLACES the visible
  text for assistive tech so a screen-reader user never hears "Present?" vs "Present"; the chips
  are `size="sm"` (32px) against a ~44px thumb target; and neither mode renders an empty-state
  fallback for a club with zero rows, while the Guests group and the read-only record both do.
  **Priority:** P2

## Print & artifacts

- The canonical meeting page (`club.$clubId.meeting.$meetingId.tsx`) is the one logo-supplying loader with no test on its `logoUrl` wiring. v1.5.0.0 covered the two standalone public print routes after a coverage audit forced all four loaders to null and the whole suite stayed green; this one was left because the route imports enough that isolating it needs more mocking than the other two. Its only logo consumer is still the `.pptx` export, so the blast radius is one surface — but the path moved in v1.11.0.0 (#541): `PptxDownloadButton`'s `logoUrl` prop is gone and `downloadDeckPptx` reads the logo off the deck's title slide, so the untested seam is now loader → `buildSlideDeck` → title slide. Same seam, still untested.
  **Priority:** P4

- The print page-count gate (v1.8.4.0, #502) has three known blind spots, each mutation-verified as surviving. (1) A PARTIAL loss of the guard's recursive route walk is undetected: the vacuity check only asserts more than 20 route files are found, so losing the whole `_authed/**` subtree — 12 files, including `vp-membership.tsx`, the one other `@media print` route and the stated reason recursion exists — still passes. (2) The walk only sees `.tsx`, skips symlinked directories (`Dirent.isDirectory()` is false for them), and the "no route hand-rolls its own page CSS" check keys on `.pgwrap` specifically, so a route wrapping its sheet in any other class is unenrolled. (3) `PRINT_PAGE_CSS`'s two `body { background }` rules are pinned by nothing at all — the count cannot see a background and no grep asserts them. Separately, the agenda fixtures build `rows` by hand and omit `roleKey`, which `expandRunSheet` always sets, so every fixture row takes a name-matching fallback branch the real route never takes.
  **Priority:** P4

## Voting

- A write-in cannot be removed once cast (#582). The ballot is public and unauthenticated, so anyone with the link can put an arbitrary string in front of the room: it appears as a tappable candidate for every later voter, in the Ballot Counter's tally, and — if crowned — on the projected awards slide and in the minutes PDF. Nothing today lets the Vote Counter delete one before results are read. Bounded in LENGTH (`WRITE_IN_LIMITS.name`, 80) and in ROWS (one per voter per category, and the per-meeting guest cap bounds voters), so this is a nuisance surface rather than a DoS one — but it is the obvious next ask the first time someone abuses it, and it is much cheaper to add beside the existing tally UI than to retrofit. Deliberately out of scope for the first cut; the decision is recorded on the issue.
  **Priority:** P2

## Guests & identity

- `members_club_idx` is now a strict prefix of `members_club_person_unique` and serves no query the composite cannot, so it is dead weight on every members write. Dropping it is a follow-up migration; `members_person_idx` must stay (person_id is the trailing column and `people-merge-logic.ts` looks up by person alone).
  **Priority:** P4

- `PHONE_CANDIDATE_LIMIT = 50` is untested on both dedup scans — shrinking it to 3 is invisible to the suite. Pinning it needs 51 same-phone rows with the only agreeing row sorting last, which is a slow fixture for a documented-and-safe overrun (the cap can only ever mean "no match", which creates a fresh Person).
  **Priority:** P4

- Two meetings on the same club-local day: `resolveCurrentMeeting` takes the FIRST row in `asc(scheduledAt)` order that is in progress, so a club running an 08:00 special session and its regular 19:00 meeting could file a 19:15 guest-book signature against the 08:00 one. Narrowed a lot by v1.9.0.0 — the window is now `[start − 90min, end + 60min]` rather than the whole calendar day, so the two meetings must be within ~2.5h to overlap at all — but not closed. Fix is to pick the CLOSEST in-progress meeting rather than the earliest. Silent when it happens: the row looks identical to a correct one afterwards.
  **Priority:** P3

- `submitGuestBook` writes a `meeting_attendance` row with `status: "present"` during a live meeting, and `minutes-logic.ts` reads that table with no date gate — so an unauthenticated caller can assert a fact into the club's official minutes, which are then emailed out. RATE LIMITING is done (v1.10.3.0, 30 new guests per club per hour, and the same TOCTOU fixed on #326's roster cap), so the volume is bounded. What is NOT done is the modelling: `meeting_attendance` stores "an officer marked you present" and "someone typed your name into a public form" identically, and the minutes present both as fact. The real fix is provenance — a `source` column (`officer` | `self_reported`) so the minutes can render a self-report distinctly or hold it for a tap — not more prevention. Gating the write behind officer confirmation as a first step would be worse: it silently drops guests when nobody is watching the console. Needs a migration plus minutes/PDF/email changes, so it wants a spec rather than a patch.
  **Priority:** P3

- #541 PR 1, deferred by /qa (2026-08-10) — the meeting "Print & export" dropdown sits flush against the RIGHT viewport edge at 375px (measured: menu `right` = 375 = viewport width), so it touches the screen edge and clips its own shadow while every card on the page keeps a ~16px gutter. Nothing overflows and no content is cut off, which is why it is here and not an issue. Fix is `collisionPadding` on `DropdownMenuContent`; do it in PR 2 with the rest of the mobile chrome pass.
  **Priority:** P4

- #541 PR 1, deferred by /qa (2026-08-10) — an ANONYMOUS visitor with a stored identity gets the filled phase primary popping in after hydration: identity lives in `localStorage`, so the SSR HTML contains zero occurrences of `toolbar-primary` (verified by curl) and the button appears on hydration, shifting the rest of the toolbar row right. Only on meeting day, only for anon-with-identity. Inherent to localStorage identity — a real fix is reserved space or cookie-backed identity, which is a design change, not a patch. Matches the final #541 review's Minor 4.
  **Priority:** P4

## Completed

- `attendance-plan-backfill.integration.test.ts` read the plan table with no filter, so its count
  assertions counted rows every other suite had written. Vitest runs files in parallel and eighteen
  of them write `meeting_attendance_plan`; `expect(rows.size).toBe(1)` was seen getting `2`, then
  passing alone and on re-run, which reads as a flake in whatever branch is open. Fixed by scoping
  `planRows()` to the fixture's own meeting, not by retrying — a cross-club read is wrong on its own
  terms, since it makes the assertion depend on what else the runner scheduled. Verified by planting
  a foreign plan row in `tm_test` and running the suite both ways: scoped passes 5/5, unscoped fails
  **three** tests. Three, not the two this entry originally claimed — the count missed the inline
  `(await planRows()).size).toBe(0)`.

  **The sweep that accompanied this fix was narrower than it claimed, and this entry originally
  overstated it.** It checked reads of `meeting_attendance_plan`, `activity_log`, `members` and
  `meetings` for a MISSING club/meeting filter, and on that basis said the class was closed. It is
  not: a read can carry a filter that does not isolate the fixture. `onboarding-logic.integration.test.ts:135-145`
  asserts `expect(secondClub.length).toBe(0)` scoped by the literal `clubs.name = "Second Club"`,
  and `expect(orphanPerson.length).toBe(0)` scoped by `people.email = "second@example.com"` — so
  any concurrent suite (or a row left by an earlier failed run) that creates either makes those
  assertions fail. It flaked exactly that way during the PR-3 review round, passing in isolation
  and on re-run. Same failure mode as the bug this entry is about, different shape, so the original
  sweep could not have seen it. Re-sweep for reads scoped by a HARDCODED literal, not only for
  reads missing a filter.
  **Completed:** shipped with the planned-attendance roll-mode release (2026-08-17) — rode
  along with that branch rather than shipping as its own version, so the version it lands
  under is whatever `/ship` assigns that PR.

- An impersonation session outlived the superadmin's own access. `getActiveImpersonationForUser`
  selected on `superadminUserId` / `endedAt` / `expiresAt` and never re-read `user.is_superadmin`,
  while `reconcileSuperadminFlag` runs on the SIGN-IN hook and touches no session — so removing an
  address from `SUPERADMIN_EMAILS` left an open session granting club reads for the rest of its TTL
  (60 min read-only, 15 read-write). ADR-0016 §2 accepts that the FLAG lags until next sign-in, but
  that was written before impersonation existed and a session is a second, separate grant. One join
  plus `eq(user.isSuperadmin, true)` closes it; revocation now lands on the operator's next request.
  **Completed:** v1.13.2.0 (2026-08-15) — #567

- The archive check cost an avoidable round-trip on every gated read. `assertClubNotArchived` issued
  its own `SELECT archived_at FROM clubs` for a row `getMembership` was about to resolve anyway, so
  each gate ran 2 statements instead of 1 and `/admin/vpe-dashboard` spent 9 on pure authorization
  rather than 6. `getMembership` now carries `clubs.archived_at` on a join (with `clubs.archivedAt`
  added to the `groupBy` — Postgres does not infer functional dependency across a join), the member
  arms read the resolved row, and only the memberless impersonation arm still queries. Pinned by a
  driver-level statement count in `archive-club.integration.test.ts` rather than a spy on a named
  loader, so a later refactor that reintroduces the lookup by any means fails.
  **Completed:** v1.13.2.0 (2026-08-15) — #566

- The derived enrollment sweep in `public-readers-archive-gate.guard.test.ts` reported green while
  skipping a reader. `serverFnBody` ended a declaration at a literal `\n});`, but every
  `createServerFn` here closes at one tab because `.handler(` is chained one level in — so the slice
  ran past the declaration and swallowed whatever followed. `getMinutes` absorbed `gateAdmin`,
  matched THAT function's `requireUser`, and was filed as session-guarded and skipped, which is how
  the #560 minutes leak reached production behind 54/54 green. Measured before the fix: 40 of 162
  slices over-captured, one by 11,000 characters. The slice now ends at the next top-level
  declaration, `getMinutes` is enrolled with a WIRINGS row, and a new vacuity case fails on any
  slice that runs past its own declaration rather than letting the next recurrence be invisible.
  **Completed:** v1.13.1.1 (2026-08-15) — #565

- An impossible meeting date in a URL silently resolved to a REAL, different meeting. `parseMeetingKey` was shape-only, and `Date.UTC` overflow-rolls, so `2026-09-31` returned October 1st's meeting with a 200 — on the public ballot, a vote cast in a meeting nobody chose. The 500 originally recorded here (`9999-99-99`) was the loud minority case; the silent roll was the bug. Fixed by rejecting impossible dates (and times) at parse, which covers all four public meeting routes at once.
  **Completed:** v1.10.2.0 (2026-08-10)

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
