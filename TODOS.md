# TODOS

> **GitHub issues are the canonical tracker** (`abustamam/tm-scheduler`, managed via `gh`). See `docs/agents/issue-tracker.md`.
>
> This file is for in-flight work that is not worth an issue yet: follow-ups noticed mid-branch, deferred pieces of something currently being built. Anything that outlives the branch it was noticed on should become an issue, and the entry here should be deleted rather than mirrored.
>
> Format: group under `## <Component>`, one `**Priority:**` (P0-P4) per item, completed items move to `## Completed` with the version that shipped them. `/ship` reads this file and moves items itself when the diff shows the work is done.

## Meetings

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

- Print chrome is duplicated across three routes: `toolbarStyle` and `printBtnStyle` are near-identical in the agenda print route, the club role sheet, and the Word of the Day poster, and the `@media print` block is a near-copy in all three. That duplication is not cosmetic — it caused a real defect. The poster shipped without the `.pgwrap { padding: 0 !important }` reset the other two carry, emitting a blank second page on every print. `print-page-reset.guard.test.ts` now pins that rule by source grep across all print routes, so the specific bug cannot recur, but the duplication remains. Extracting a shared `PRINT_PAGE_CSS` and a `<PrintToolbar>` into `print-theme.tsx` would collapse three copies to one and let the guard assert against one constant.

  **They are NOT interchangeable copies — an extraction must be the union, not whichever one you open first.** Three known divergences:
  - The agenda print route's `toolbarStyle` alone carries `flexWrap: "wrap"` and `justifyContent: "flex-end"`. Load-bearing, with a comment saying so: that toolbar holds four layout tabs plus Share and Print, and anchored right with no width an unwrapped row grows leftward off the viewport on a phone, where a `position: fixed` toolbar cannot be scrolled back to. Extracting from the role sheet's or the poster's copy would silently reintroduce that.
  - The poster's `printBtnStyle` uses the `LAGOON` token from `print-theme.tsx`; the other two hardcode `#328f97`. The token is the direction to keep.
  - The `@media print` blocks differ in body too. All three reset `.pgwrap` padding, but the agenda route also zeroes `gap`, and the poster omits the `break-after: page` / `.agenda-page:last-child` pair the multi-sheet routes need — it prints exactly one sheet. A shared constant has to keep the pagination rules harmless for a one-sheet page. Diff all three before assuming one covers them.
  **Priority:** P3

- Print output is grep-verified, never page-count-verified. `print-page-reset.guard.test.ts` checks that the reset rule is present in the source; nothing checks that a rendered page is actually one page. The blank-second-page bug was found by extracting the CSS and counting pages in headless Chrome, which is the real check. Worth wiring once `PRINT_PAGE_CSS` is extracted — one extract-and-count assertion would then cover every print route.
  **Priority:** P4

- `scripts/measure-word-poster.ts` has no tests because `main()` runs at import, so nothing is reachable. It is the harness that derives the Word of the Day poster's font-size tables, and a wrong result there ships mid-word breaks on a wall poster. `scripts/import-agendas-logic.ts` is the repo's precedent for extracting a testable `*-logic.ts` alongside an entry-point script.
  **Priority:** P4

## Guests & identity

- `members_club_idx` is now a strict prefix of `members_club_person_unique` and serves no query the composite cannot, so it is dead weight on every members write. Dropping it is a follow-up migration; `members_person_idx` must stay (person_id is the trailing column and `people-merge-logic.ts` looks up by person alone).
  **Priority:** P4

- `PHONE_CANDIDATE_LIMIT = 50` is untested on both dedup scans — shrinking it to 3 is invisible to the suite. Pinning it needs 51 same-phone rows with the only agreeing row sorting last, which is a slow fixture for a documented-and-safe overrun (the cap can only ever mean "no match", which creates a fresh Person).
  **Priority:** P4

## Completed

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
