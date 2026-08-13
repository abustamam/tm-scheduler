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

## Tooling

- `bun run fix` writes the whole tree, and there is no scoped variant. Fine today (it is a verified no-op on a clean tree), but two things make a scoped one worth having before anyone wires it into a hook: `biome check --changed` hard-errors here because `biome.json`'s `vcs` block has no `defaultBranch`, and a `pre-commit` hook running the unscoped `fix` would sweep unrelated working-tree drift into the commit. `--staged` is verified working, so `"fix:staged": "biome check --write --staged"` plus `"defaultBranch": "main"` in the `vcs` block would close both.
  **Priority:** P4

- Biome's `files.includes` covers `src/**`, `.vscode/**`, `index.html` and `vite.config.ts` only, so `scripts/**`, `drizzle.config.ts`, `vitest.config.ts` and the whole `extension/` sub-package are outside the gate entirely. `extension/` has no Biome config and no Biome step in its CI job, yet some plans instruct running Biome from inside it, where it resolves the root config that excludes those paths. Decide whether those paths should be linted or explicitly declared out of scope.
  **Priority:** P4

## Agenda

- Confirm the hand-off rows on a real MCF agenda after it deploys — that the four print layouts read right in the room and the projected deck's hand-off slides land where the cue is needed.
  **Priority:** P3

- `scripts/measure-word-poster.ts` has no tests because `main()` runs at import, so nothing is reachable. It is the harness that derives the Word of the Day poster's font-size tables, and a wrong result there ships mid-word breaks on a wall poster. `scripts/import-agendas-logic.ts` is the repo's precedent for extracting a testable `*-logic.ts` alongside an entry-point script.
  **Priority:** P4

## Testing

- Two integration suites hand-copy queries that #544 turned into reachable seams, so they now assert against copies that can never fail when production changes. `public-reads.integration.test.ts` has `listUpcomingMeetingsPublic` (a verbatim mirror of what is now `loadPublicUpcomingMeetings`) and `getMeetingPublic` (a mirror of `loadMeetingDetail`); `member-status.integration.test.ts` has `listActiveMembers` (a mirror of what is now `loadPublicClubRoster`). The first two are the repo's "a parity test cannot see a defect present on both sides" trap with the twist that only one side is production code — and the mirrors carry no archive gate, so they have already diverged. Both files already `vi.mock("#/db")`, so re-pointing them at the real seams is a small edit. `getMeetingPublic` cannot be re-pointed until `loadMeetingDetail` is exported from a `*-logic` module.
  **Priority:** P3

## Print & artifacts

- Editorial wastes roughly 635px of its own sheet, and that space is the largest remaining lever on how big the agenda prints. Measured at v1.13.0.0 with `measuredHeight`: the main column (roster + run of show) is 1304px and sets the whole page, while the left rail (7 officers + meets + location + the full club mission + announcements) stops at 669px. Since `FitPage` scales the sheet to fit, every pixel the main column is taller than 1056 is type size taken away — so moving the Meeting Roles roster into the rail, or flowing the run of show into the space under it, converts empty paper directly into legibility. #562 deliberately stopped short: it is a redesign of the layout, not a tuning of it, and the consolidation plus a measured font bump already took body text from 5.59pt to 6.88pt. Worth an issue rather than a branch if it gets picked up.
  **Priority:** P3

- The canonical meeting page (`club.$clubId.meeting.$meetingId.tsx`) is the one logo-supplying loader with no test on its `logoUrl` wiring. v1.5.0.0 covered the two standalone public print routes after a coverage audit forced all four loaders to null and the whole suite stayed green; this one was left because the route imports enough that isolating it needs more mocking than the other two. Its only logo consumer is still the `.pptx` export, so the blast radius is one surface — but the path moved in v1.11.0.0 (#541): `PptxDownloadButton`'s `logoUrl` prop is gone and `downloadDeckPptx` reads the logo off the deck's title slide, so the untested seam is now loader → `buildSlideDeck` → title slide. Same seam, still untested.
  **Priority:** P4

- The print page-count gate (v1.8.4.0, #502) has three known blind spots, each mutation-verified as surviving. (1) A PARTIAL loss of the guard's recursive route walk is undetected: the vacuity check only asserts more than 20 route files are found, so losing the whole `_authed/**` subtree — 12 files, including `vp-membership.tsx`, the one other `@media print` route and the stated reason recursion exists — still passes. (2) The walk only sees `.tsx`, skips symlinked directories (`Dirent.isDirectory()` is false for them), and the "no route hand-rolls its own page CSS" check keys on `.pgwrap` specifically, so a route wrapping its sheet in any other class is unenrolled. (3) `PRINT_PAGE_CSS`'s two `body { background }` rules are pinned by nothing at all — the count cannot see a background and no grep asserts them. Separately, the agenda fixtures build `rows` by hand and omit `roleKey`, which `expandRunSheet` always sets, so every fixture row takes a name-matching fallback branch the real route never takes.
  **Priority:** P4

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

- An impossible meeting date in a URL silently resolved to a REAL, different meeting. `parseMeetingKey` was shape-only, and `Date.UTC` overflow-rolls, so `2026-09-31` returned October 1st's meeting with a 200 — on the public ballot, a vote cast in a meeting nobody chose. The 500 originally recorded here (`9999-99-99`) was the loud minority case; the silent roll was the bug. Fixed by rejecting impossible dates (and times) at parse, which covers all four public meeting routes at once.
  **Completed:** v1.10.2.0 (2026-08-10)

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
