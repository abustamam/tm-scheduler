# TODOS

> **GitHub issues are the canonical tracker** (`abustamam/tm-scheduler`, managed via `gh`). See `docs/agents/issue-tracker.md`.
>
> This file is for in-flight work that is not worth an issue yet: follow-ups noticed mid-branch, deferred pieces of something currently being built. Anything that outlives the branch it was noticed on should become an issue, and the entry here should be deleted rather than mirrored.
>
> Format: group under `## <Component>`, one `**Priority:**` (P0-P4) per item, completed items move to `## Completed` with the version that shipped them. `/ship` reads this file and moves items itself when the diff shows the work is done.

## Meetings

- A date-SHAPED but invalid meeting key (`9999-99-99` — passes the date regex, fails the calendar) still returns 500 on all four public meeting routes (`print`, `present`, `word`, `vote`). It throws `"Invalid date/time."` from inside `resolveMeetingKey`, which `isMeetingNotFoundError` does not match, so the `.catch` that translates a missing meeting into a 404 (v1.10.1.0) lets it through. Pre-existing and identical across all four, so it is not a ballot-specific gap — but these are public unauthenticated routes and the ballot one is printed on a QR code, so a fat-fingered date is reachable. Fix is one more predicate, or making `resolveMeetingKey` return null for an unparseable date rather than throwing.
  **Priority:** P3

- An ex-member can still see a departed club's forward schedule. `userMemberIds` deliberately ignores `members.status`, and the deactivation sweep in `members-logic.ts` skips slots on CANCELLED meetings, while `applyReopenMeeting` restores a meeting without clearing assignments. Cancel a meeting, deactivate a member, reopen it, and their `/me` shows that club's date, theme and location with a Release button that dead-ends. Needs all three steps, so it is debt rather than scheduled work.
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

## Print & artifacts

- The canonical meeting page (`club.$clubId.meeting.$meetingId.tsx`) is the one logo-supplying loader with no test on its `logoUrl` wiring. v1.5.0.0 covered the two standalone public print routes after a coverage audit forced all four loaders to null and the whole suite stayed green; this one was left because the route imports enough that isolating it needs more mocking than the other two. Its only logo consumer is the `.pptx` button, so the blast radius is one surface — but it is the same seam, untested.
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

- `submitGuestBook` is an unauthenticated, unrate-limited POST that writes a `guests` row and (during a meeting) a `meeting_attendance` row that reaches the official minutes. Deliberate since #239 — the club link is the credential — but v1.9.0.0 removed its obscurity by linking the guest book from the public club page, where before the URL appeared only on the officer's printed QR code. Club numbers are public and `resolveClubByIdentifier` accepts them, so the surface is guessable. Worth deciding explicitly whether to add a rate limit before this gets traffic. Narrowed but NOT closed by v1.10.0.0: a pre-landing review proved 70 guest-book posts could become 70 ballots, so `castVote` now requires a `meeting_ballot_guests` link and the per-meeting cap counts links rather than row inserts — a guest-book row is no longer a ballot identity. The row-spam and minutes-attendance halves of this are untouched, and the CTA makes them likelier.
  **Priority:** P3

## Completed

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
