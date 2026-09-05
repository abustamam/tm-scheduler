# remove-self-add-630

Debt found while deleting `applySelfAdd` (#630). Nothing here is a filed issue —
none of it clears CLAUDE.md's bar ("a correctness or security bug a user can
actually hit, or work you would genuinely schedule").

## `captureGuestVisit` pre-checks the archive outside a lock it already holds

`src/server/guest-pipeline-logic.ts` calls `assertClubNotArchived(input.clubId)`
as its FIRST statement, then opens a transaction that takes
`SELECT id FROM clubs WHERE id = … FOR UPDATE` on the create path (the guest-book
throttle). So it is check-then-act with a lock available to gate inside — the
exact shape `applySelfAdd` was built to avoid, and the reason CODING_STANDARDS.md
now warns against repointing that worked example here.

The window is a superadmin takedown landing between the assert and the insert:
milliseconds wide, and the row it leaves is a guest in a club every read already
reports as gone. Not filed for that reason. Moving the read into the locked
statement is a few lines, but it is a behaviour change to the archive gate and
needs its own before/after case in
`public-writers-archive-gate.integration.test.ts`, so it did not belong in a
pure-removal PR.

## `member-write-authz.guard.test.ts` matches seams by NAME

The sweep detects a member-writing handler by a regex of seam names. #630 added
`applyConvertGuestToMember` and `createClubWithAdmin`, which write `members` and
were invisible to it (both are gated — `requireClubRole` and `requireSuperadmin`
— so nothing was wrong, only unwatched). A new seam under a new name is still
invisible until someone adds it. The census case added at #630 catches the sweep
going to zero; it cannot catch the sweep missing one of N. A structural detector
(does this handler's call graph reach `insert(members)`?) is the real fix and is
a bigger change than this issue.

## `releaseSlot` / `updateSpeakerDetails` still gate in the handler

Pre-existing, already recorded in `TODOS/legacy-2026-09.md`. Noted here only
because #630 re-read that list: they are the two session-less writes a source
grep is the only cover for, since their logic is inline in `slots.ts` and a
handler body is unreachable from vitest.
