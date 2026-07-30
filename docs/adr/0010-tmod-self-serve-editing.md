# ADR-0010: TMOD self-serve meeting editing (interim, no-auth)

Status: Accepted

## Context

Meeting editing (meta + slot management) is `admin`/`vpe`-only, behind `requireUser()` +
`requireClubRole`. But the person actually running a meeting is usually the **Toastmaster of
the Day (TMOD)** — a roster member who does not sign in. In the self-serve model only the one
admin/VPE is authenticated; everyone else uses the public shareable meeting link and
self-asserts identity (a client-supplied `memberId`, trusted with no verification) to claim
roles, made safe by the activity log. See #67.

The founder wants the assigned TMOD to run their own meeting without waiting on the VPE, and
accepts self-assert trust "while we figure out auth" (real accounts are the eventual direction
— ADR-0008).

## Decision

Let the meeting's assigned TMOD edit that meeting's **agenda content** from the public page,
using the **same self-assert trust level as claiming** — no token, no session.

- **Authorization gate:** a per-meeting agenda write is allowed if the caller is a club
  `admin`/`vpe` **or** the self-asserted `memberId` equals the `assignedMemberId` of that
  meeting's **TMOD slot**. This is *tighter* than claiming: you must already hold the TMOD
  role, not merely pick a name. If the TMOD slot is unassigned, there is no self-serve
  editor and editing falls back to `admin`/`vpe` only.
- **Which slot is the TMOD slot is decided by `role_definitions.key`
  (`toastmaster_of_the_day`), not by the role's display name.** Clubs rename roles freely
  (#368), so a name match got it wrong in both directions: renaming "Toastmaster of the Day"
  to "MC" silently revoked the capability, and any club-invented role whose name merely began
  with "Toastmaster" — an assistant, a trainee — was granted it, server-side. A row whose
  `key` is still NULL falls back to an **exact** canonical-name match, never a prefix. One
  resolver (`findTmodSlot`, `src/lib/meeting-roles.ts`) backs both the client affordance and
  this gate. See #464.
- **Scope — TMOD may:** edit meta (theme, Word of the Day, notes, location); assign a member
  to any slot; unassign a member; and add/remove slots (change the speaker count). Everything
  is activity-logged via `actorMemberId`.
- **Scope — `admin`/`vpe` only:** reschedule (`scheduledAt`/`lengthMinutes`), cancel, and
  meeting status — these are club decisions, not the TMOD's.
- **Mechanics:** the existing per-meeting server fns gain a shared authorization helper
  (admin/vpe **or** meeting-TMOD self-assert) instead of a hard `requireClubRole`.

## Consequences

- The TMOD can run their meeting end-to-end without the VPE; edits are attributable and
  reversible via the activity log, and the admin/VPE can always override.
- The self-assert trust boundary widens from claiming to full agenda editing. The accepted
  residual risk: anyone who claims an *open* TMOD slot can then edit that meeting's agenda —
  tolerated in the self-serve model, mitigated by logging + admin override.
- **The gate fails closed on an unbackfilled rename, and no club is in that state.** Because
  the name fallback is exact, a club that renamed its TMOD role *before* `key` existed to
  something still containing the canonical word ("Toastmaster of the Evening") would have no
  self-serve editor until its `key` was backfilled. That population is empty — nothing was
  ever renamed before `drizzle/0044` ran — and it cannot grow, because
  `applyRoleDefinitionUpdate` never touches `key`, so every later rename keeps it. #466 was
  filed for a backfill migration and closed as unnecessary. If such a club ever appears, fix
  it by backfilling that row's `key`; do **not** widen the fallback back to a prefix, which is
  the exact hole #464 closed.
- **Interim by design.** When real per-member auth lands (ADR-0008 convergence), the
  self-assert gate should be replaced by an authenticated identity check; this ADR is the
  marker for that follow-up.
- Reschedule/cancel/status remain a genuine `admin`/`vpe` boundary, so the destructive
  meeting-lifecycle actions never ride on self-assert.
