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

## Completed

<!-- Items move here with: **Completed:** vX.Y.Z.W (YYYY-MM-DD) -->

- The MCF handback beat ("Toastmaster of the Day · Introduces the speakers") has no counterpart slide in the projected deck, so a Toastmaster running the meeting off the projector alone does not see the cue.
  **Priority:** P4
  **Completed:** v1.1.0.0 (2026-07-29) — every hand-off now has a matching slide, labelled by target.
