# release-roles-subject-check-675

Left over from #675, which gave `markUnavailableReleasing` the subject check it never had.

- **An anonymous caller who asserts NOTHING is still admitted as the subject.** The D6 ladder
  binds a caller who *claims* an identity; with no session and no `claimedActorMemberId` its last
  arm resolves the caller TO the subject and the write goes through. That is the product's
  identity model (#317) — `claimSlot` and `releaseSlot` already run on it, and `releaseSlot`
  already lets an anonymous caller free one slot at a time — and it is why #675 is *parity* with
  `setPlannedAttendance` rather than a forgery fix. So the issue's "empty a club's upcoming
  agendas in one request per (member, meeting)" scenario is narrowed (a season-grid client always
  sends an actor, and now fails loudly when it names someone else) but not closed. The thing that
  would actually bound it is the issue's own second suggestion: a per-club rate limit in front of
  the slot `UPDATE`. Deliberately not built here — it needs a decision about where the counter
  lives and what a legitimate burst looks like on meeting night.
  **Priority:** P2

- **`setAvailability` / `clearAvailability` were audited and left.** The issue asked for the pair
  to be looked at in the same pass. Both still take a self-asserted `actorMemberId` with no
  subject check, and both are strictly less destructive: `setAvailability` writes `not_coming`
  and releases nothing, `clearAvailability` deletes only `SELF_SERVICE_RUNGS` so an officer's
  `reached_out` stays out of reach. Their damage is recoverable by re-answering; a released role
  is not. Routing them through `resolveActor` too would be the symmetric fix, and would change
  the season grid's availability toggle for a non-officer acting on someone else — which is a
  product decision, not a cleanup. Their docblocks in `availability.ts` now say what
  `requireMemberInClub` does and does not prove, so the next reader does not have to re-derive it.
  **Priority:** P3

- **The seam trusts the `clubId` it is handed.** `releaseSlotsAndMarkUnavailable` takes `clubId`
  as a parameter and scopes the archive check and the whole ladder to it. Its one production
  caller reads it off the meeting row (#396) and `availability-authz.guard.test.ts` pins the
  handler ordering, but the seam itself could derive it from `args.meetingId` and stop depending
  on a caller getting that right. One extra round trip, or a merged `loadMeeting` the handler
  already makes.
  **Priority:** P3

- **`markUnavailableReleasing` is not in `WRITE_GATES`.** The archive-gate sweep in
  `public-readers-archive-gate.guard.test.ts` exempts it because its handler calls
  `requireMemberInClub`, which the sweep reads as a session guard (it is not one). Its gate is
  covered instead by `delegate-rungs.guard.test.ts` for the handler and, since #675, executed by
  `availability.integration.test.ts` for the seam. Enrolling it properly means adding a row to
  that table, a case to `public-writers-archive-gate.integration.test.ts`, and updating the "five
  of these gate in a `-logic` seam" prose in both that file and `CODING_STANDARDS.md` — worth
  doing next time that table is touched, not as a side effect of an authorization fix.
  **Priority:** P4
