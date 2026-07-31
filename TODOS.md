# TODOS

> **GitHub issues are the canonical tracker** (`abustamam/tm-scheduler`, managed via `gh`). See `docs/agents/issue-tracker.md`.
>
> This file is for in-flight work that is not worth an issue yet: follow-ups noticed mid-branch, deferred pieces of something currently being built. Anything that outlives the branch it was noticed on should become an issue, and the entry here should be deleted rather than mirrored.
>
> Format: group under `## <Component>`, one `**Priority:**` (P0-P4) per item, completed items move to `## Completed` with the version that shipped them. `/ship` reads this file and moves items itself when the diff shows the work is done.

## Meetings

- An ex-member can still see a departed club's forward schedule. `userMemberIds` deliberately ignores `members.status`, and the deactivation sweep in `members-logic.ts` skips slots on CANCELLED meetings, while `applyReopenMeeting` restores a meeting without clearing assignments. Cancel a meeting, deactivate a member, reopen it, and their `/me` shows that club's date, theme and location with a Release button that dead-ends. Needs all three steps, so it is debt rather than scheduled work.
  **Priority:** P4

## Agenda

- Confirm the hand-off rows on a real MCF agenda after it deploys — that the four print layouts read right in the room and the projected deck's hand-off slides land where the cue is needed.
  **Priority:** P3

- Print chrome is duplicated across three routes: `toolbarStyle` and `printBtnStyle` are byte-identical in the agenda print route, the club role sheet, and the Word of the Day poster, and the `@media print` block is a near-copy in all three. That duplication is not cosmetic — it caused a real defect. The poster shipped without the `.pgwrap { padding: 0 !important }` reset the other two carry, emitting a blank second page on every print. `print-page-reset.guard.test.ts` now pins that rule by source grep across all print routes, so the specific bug cannot recur, but the duplication remains. Extracting a shared `PRINT_PAGE_CSS` and a `<PrintToolbar>` into `print-theme.tsx` would collapse three copies to one and let the guard assert against one constant.
  **Priority:** P3

- Print output is grep-verified, never page-count-verified. `print-page-reset.guard.test.ts` checks that the reset rule is present in the source; nothing checks that a rendered page is actually one page. The blank-second-page bug was found by extracting the CSS and counting pages in headless Chrome, which is the real check. Worth wiring once `PRINT_PAGE_CSS` is extracted — one extract-and-count assertion would then cover every print route.
  **Priority:** P4

- `scripts/measure-word-poster.ts` has no tests because `main()` runs at import, so nothing is reachable. It is the harness that derives the Word of the Day poster's font-size tables, and a wrong result there ships mid-word breaks on a wall poster. `scripts/import-agendas-logic.ts` is the repo's precedent for extracting a testable `*-logic.ts` alongside an entry-point script.
  **Priority:** P4

## Completed

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
