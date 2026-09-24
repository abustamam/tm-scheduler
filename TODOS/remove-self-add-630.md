# remove-self-add-630

Debt found while deleting `applySelfAdd` (#630). Nothing here is a filed issue —
none of it clears CLAUDE.md's bar ("a correctness or security bug a user can
actually hit, or work you would genuinely schedule").

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

## `members.integration.test.ts` asserts its own INSERTs

Found by the Standards review axis on PR #692; pre-existing, NOT a #630
regression. `insertRosterMember` writes the `members` row and the `member_add`
`activity_log` row itself, and `it("a roster add inserts the member and logs
member_add")` then asserts those exact rows exist — so the case asserts that
`testDb.insert` inserts, and passes with every production seam deleted. The file
imports no production code at all; `listMembersPublic` is a hand-rolled replica
of `loadPublicClubRoster` and has already drifted (it omits `officerPositions`,
which the real fn returns).

`main`'s `addMemberPublic` hand-rolled the identical two inserts, so #630 only
renamed it. The header now says so outright rather than implying a link to
`applyBulkImport`.

The fix is to drive the real seam the way `public-writers-archive-gate.integration.test.ts`
already does in this same module — `vi.mock("#/db", …)` plus a dynamic import —
and to import `loadPublicClubRoster` instead of replicating its query. That is a
rewrite of three cases, not a removal, which is why it is parked rather than done
inside a deletion PR. Worth doing: the drifted replica shows the failure mode is
live, not theoretical.
