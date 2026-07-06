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
- **Interim by design.** When real per-member auth lands (ADR-0008 convergence), the
  self-assert gate should be replaced by an authenticated identity check; this ADR is the
  marker for that follow-up.
- Reschedule/cancel/status remain a genuine `admin`/`vpe` boundary, so the destructive
  meeting-lifecycle actions never ride on self-assert.
