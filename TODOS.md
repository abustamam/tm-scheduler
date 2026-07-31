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

- The Word of the Day poster route has no route-component render test, so its empty-state branch is unguarded: the heading and back-link, the negative assertion that the poster and Print button do not render, and the wiring that passes `"word-of-the-day"` to `meetingPdfBasename`. That branch already regressed once (it shipped effectively invisible in dark mode, using the print `INK` token at 1.52:1 against the app background) and the fix carries no regression test. The spec asked for this test; it was dropped because this repo has no route-component render tests anywhere, so there is no pattern to copy. Establishing one would pay off beyond this route.
  **Priority:** P3

- Print chrome is now duplicated across three routes: `toolbarStyle` and `printBtnStyle` are byte-identical in the agenda print route, the club role sheet, and the Word of the Day poster, and the `@media print` block is a near-copy in all three. That duplication is not cosmetic — it caused a real defect. The poster shipped without the `.pgwrap { padding: 0 !important }` reset the other two carry, emitting a blank second page on every print, and nothing in the repo could catch it because print CSS has no test surface. Extracting a shared `PRINT_PAGE_CSS` and a `<PrintToolbar>` into `print-theme.tsx` would collapse three copies to one, and the extract-CSS-and-count-PDF-pages check used to find the bug could then run as a single assertion instead of three.
  **Priority:** P3

## Completed

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
