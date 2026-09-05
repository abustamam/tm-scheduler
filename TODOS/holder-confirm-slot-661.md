# holder-confirm-slot-661

Debt noticed while admitting the slot's own holder to `confirmSlot` (#661).
Nothing here clears CLAUDE.md's bar for an issue ("a correctness or security bug
a user can actually hit, or work you would genuinely schedule").

## The holder arm has no client yet

**Priority:** P2

#661's `## Files` list is server-only, so nothing in `src/routes/` sends the new
`memberId`. The arm is therefore live but unreachable from the product: every
call the app makes today omits the field and takes the officer arm, exactly as
before. That is deliberate — the issue is about making "confirmed" *able* to mean
"the person said yes" — but it means the feature ships with zero user-visible
change, and a reviewer looking for one will not find it.

The client half is a confirm affordance on the sign-up sheet's own slot card,
beside claim/release, sending the same `useEffectiveMember` id those two already
send. It is a separate issue when someone wants it, not a follow-up to this one.

Until then the second half of `TODOS/legacy-2026-09.md`'s attendance-rail item is
only half-closed: the rail can now tell a real "coming" from an officer's vouch,
but a member still has no way to produce one from a confirm.

## `slots.confirm.test.ts` is a mirror suite, now redundant

**Priority:** P3

`src/server/slots.confirm.test.ts` reproduces `confirmSlot`'s conditional UPDATE
(`confirmSlotTx`) and its admin role check by hand rather than calling anything —
its own header says so ("reproduce the exact conditional UPDATE guards from
`src/server/slots.ts`"), which was the only option while that logic lived in a
handler body. It no longer is: `confirmSlotCore` is a seam, and
`slots-confirm.integration.test.ts` executes the real thing including both arms,
the archive gate and the lock.

So four of its six cases now assert a copy of code they could call, and would
keep passing if `confirmSlotCore` were deleted. The two `unconfirmSlot` cases are
still the only cover for that fn, which IS still handler-inline — so this is a
rewrite (point the confirm cases at the seam, leave the unconfirm mirrors with a
comment saying why they are mirrors), not a deletion. Left out of #661 to keep an
authorization diff small.

## An admin can still assert the holder's id

**Priority:** P4 — noted so a later reader does not re-derive it as a finding.

The self arm credits the assignee it verified against `role_slots`, following
`resolveMeetingAgendaAuthz`'s TMOD precedent, rather than running the id through
`requestWriteActor`'s membership precedence. So a signed-in club admin who sends
`memberId: <the holder>` is credited as the holder and writes a `coming` in their
name.

Not closed, because closing it for the signed-in half buys nothing: the same
request from a logged-out browser is the honour system this product runs on, and
is exactly what `claimSlot` and `setAvailability` already accept. If the honour
system is ever tightened, it gets tightened for all of these at once and in one
place — a per-endpoint patch here would just make the surface uneven.

## The slot read is still outside the transaction and takes no `FOR UPDATE`

Raised by the authorization review pass on PR #696, which found a real
check-then-act window: `confirmSlotCore` reads the slot before
`db.transaction`, so `resolveConfirmGrant` decides on a snapshot.

**The exploitable half is fixed** — the self arm's conditional UPDATE now
re-asserts `assignedMemberId = grant.holderMemberId`, so a reassignment landing
inside the window updates nothing instead of confirming the new holder's slot
and writing the plan row for the old one. `confirm-slot-race.guard.test.ts`
pins it (mutation-checked both ways).

What is left is structural: the read could simply move inside the transaction
with `.for("update")`, which would make the whole prelude — archive gate, lock
check, grant resolution — decide on the same row version the write uses, the way
`applySelfAdd` used to before #630 deleted it and the way `captureGuestVisit`
still does not. Deferred because it changes the officer arm's behaviour too and
wants its own before/after case. **Priority: P3.**

## `CONFIRM_NEEDS_SIGN_IN_MESSAGE` is a hand copy of `requireUser`'s literal

`guards.ts:60` throws `"You need to be signed in to do that."`; `slots-logic.ts`
declares its own constant with the same text, and the new suite imports the COPY.
So a reword in `guards.ts` drifts the officer arm while the suite stays green.
`guards.ts:40` already exports `NO_PERMISSION_MESSAGE` beside it, so the
precedent is to export this one and have both sites read it. **Priority: P3.**

## Nothing proves the transaction ROLLS BACK

The issue's criterion is that the confirmed status and the `coming` row are
atomic — "neither can land alone". The suite proves both land on success; no
case reaches `"Slot was no longer claimed"` with a plan write already attempted,
so the rollback half is unexecuted. Needs an `openBlockingTx`-style case.
**Priority: P3.**

## The new `WRITE_GATES` row is a file-level `toContain`

`assertClubNotArchived` occurs exactly once in `slots-logic.ts` today, so the row
is honest — but nothing pins the call INSIDE `confirmSlotCore`, and the
archive-before-lock ordering test iterates `SELF_ASSERT_RESOLVERS` only, which is
`meeting-authz-logic.ts`'s resolvers rather than this one. Behavioural cover
exists in the integration suite; the source guard is weaker than its prose
implies. **Priority: P4.**

## `ConfirmSlotVia` re-declares a slice of `setPlanStatus`'s union

`"officer" | "self"` here vs `"officer" | "tmod" | "self"` in
`attendance-plan-logic.ts:91`. One persisted field, two independent unions.
**Priority: P4.**
