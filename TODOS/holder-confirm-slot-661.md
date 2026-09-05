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
