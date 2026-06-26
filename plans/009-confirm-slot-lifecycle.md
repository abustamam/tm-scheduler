# Plan 009: Build the `claimed → confirmed` slot lifecycle (VPE confirm action)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/server/slots.ts src/server/meetings.ts src/routes/_authed/meetings.\$id.tsx src/routes/_authed/me.tsx src/db/schema.ts`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (write the test per plan 002's pattern if its harness exists)
- **Category**: direction
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/17

## Why this matters

The slot status enum has three states — `open`, `claimed`, `confirmed`
(`src/db/schema.ts:48-52`) — and the `/me` view already renders a distinct badge
for `confirmed` (`src/routes/_authed/me.tsx:80-84`). But **nothing in the app
ever sets a slot to `confirmed`**: there is no transition out of `claimed`. The
`confirmed` state and its badge are unreachable. This is a half-built lifecycle.
Closing it gives VPEs/admins the ability to lock in an agenda ("yes, this person
is confirmed for this role"), which is the natural complement to claiming — and
it makes the existing `confirmed` badge meaningful instead of dead.

This plan adds a VPE/admin-only confirm (and un-confirm) action.

## Current state

- Status enum (`src/db/schema.ts:48-52`): `open | claimed | confirmed`.
- `src/server/slots.ts` — has `claimSlot` (open→claimed) and `releaseSlot`
  (claimed→open). **No confirm.** `releaseSlot` checks
  `isAssignee || isAdmin` where `isAdmin = clubRole === "admin" || "vpe"`
  (`slots.ts:111-117`). Use that exact admin predicate for confirm.
- `getMeeting` returns `canManage` (`meetings.ts:61-62`,
  `membership.clubRole === "admin" || "vpe"`) and per-slot `status`. The detail
  UI (`meetings.$id.tsx`) already branches on `slot.status` and `canManage`
  (lines 184–211): open→Claim, else if `isMine || canManage`→Release, else Filled
  badge.
- `/me` (`me.tsx:80-84`) renders `variant={c.status === "confirmed" ? "default" : "secondary"}`
  and shows `{c.status}` as the badge text — already confirmed-aware.

Conventions: tabs + double quotes (Biome), `#/` alias, strict TS, Zod-validated
`createServerFn` inputs, transactions for writes, `toast` + `router.invalidate()`
on the client after a mutation (see `doClaim`/`doRelease` in `meetings.$id.tsx`).

## Commands you will need

| Purpose   | Command                                            | Expected |
|-----------|----------------------------------------------------|----------|
| Typecheck | `bunx tsc --noEmit`                                 | exit 0   |
| Build     | `bun run build`                                     | exit 0   |
| Test      | `TEST_DATABASE_URL=... bunx vitest run <file>`      | pass (if you add a test) |
| Lint/fmt  | `bun run check`                                     | exit 0   |

## Scope

**In scope** (modify/create):
- `src/server/slots.ts` — add `confirmSlot` (and `unconfirmSlot`, or a single
  toggle) server fn, VPE/admin-gated.
- `src/routes/_authed/meetings.$id.tsx` — add a Confirm/Unconfirm control for
  `canManage` users on `claimed`/`confirmed` slots.
- Optionally `src/server/slots.confirm.test.ts` (if plan 002's DB-test harness
  exists) — cover the transition + authorization.

**Out of scope** (do NOT touch):
- `claimSlot` / `releaseSlot` logic — leave their behavior unchanged. (Decide:
  should a member be able to `release` a `confirmed` slot? See STOP/Decisions.)
- The status enum — `confirmed` already exists; no schema change.
- `/me` badge code — it's already confirmed-aware; no change needed.

## Git workflow

- Branch: `advisor/009-confirm-slot-lifecycle`
- Conventional commit, e.g. `feat: add VPE confirm action for claimed slots`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Server function `confirmSlot`

In `src/server/slots.ts`, add a `confirmSlot` (and the inverse) modeled on
`releaseSlot`'s structure:

- Validator: `z.object({ slotId: z.string().uuid() })`.
- Load the slot + its `clubId` (same select-with-join as `releaseSlot`,
  `slots.ts:96-105`), plus the current `status` and `assignedUserId`.
- Require the user is admin/vpe in that club:
  `await requireClubRole(currentUser.id, slot.clubId, ["admin", "vpe"]);`
  (import `requireClubRole` from `./guards`).
- Guard the transition: only a `claimed` slot may be confirmed; if it's `open`
  (no assignee) throw "Only a claimed role can be confirmed." Use a **conditional
  update** mirroring the claim guard so a concurrent release can't race it:
  `UPDATE role_slots SET status='confirmed' WHERE id=? AND status='claimed'`,
  and throw if zero rows update.
- Inverse `unconfirmSlot`: `status='claimed' WHERE id=? AND status='confirmed'`.

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 2: UI control on the meeting detail

In `src/routes/_authed/meetings.$id.tsx`, in the per-slot action block
(lines 183–212), add — for `canManage` users — a Confirm button on `claimed`
slots and an Unconfirm (or a "Confirmed ✓" toggle) on `confirmed` slots. Follow
the existing `doClaim`/`doRelease` pattern exactly: set `busySlotId`, call the
server fn, `toast.success(...)`, `await router.invalidate()`, clear busy in
`finally`, `toast.error(errMessage(err))` on failure.

Keep the existing Release affordance available where it already is; Confirm is an
additional action for managers, not a replacement.

**Verify**: `bunx tsc --noEmit` → exit 0; `bun run build` → exit 0;
`bun run check` → exit 0.

### Step 3 (if plan 002's harness exists): test the transition

Add `src/server/slots.confirm.test.ts` following plan 002's `claim.integration.test.ts`
pattern: a `claimed` slot confirmed by an admin becomes `confirmed`; an `open`
slot cannot be confirmed; a non-admin member is rejected; the conditional update
returns zero rows if the slot was released to `open` first.

**Verify**: `TEST_DATABASE_URL=... bunx vitest run src/server/slots.confirm.test.ts` → pass.

## Decisions to make (resolve from the codebase, else pick the documented default)

- **Can a member release a `confirmed` slot?** Today `releaseSlot` has no status
  guard, so it would. Default for this plan: **leave `releaseSlot` as-is**
  (out of scope) but note in the doc that a follow-up may block self-release of a
  confirmed slot. If you change `releaseSlot`, that's scope creep — STOP and ask.

## Test plan

- Cases (Step 3): claimed→confirmed by admin; open cannot confirm; member
  rejected; confirmed→claimed unconfirm; race (released-then-confirm → 0 rows).
- Model after `src/server/claim.integration.test.ts` (plan 002).
- If plan 002 hasn't run, skip the test but still ship Steps 1–2 (note the
  coverage gap in `plans/README.md`).

## Done criteria

ALL must hold:

- [ ] `confirmSlot` (+ inverse) exist in `src/server/slots.ts`, VPE/admin-gated,
      using a conditional `status='claimed'` update guard
- [ ] The meeting detail UI shows a Confirm/Unconfirm control for `canManage`
      users on claimed/confirmed slots, following the `doClaim`/`doRelease` pattern
- [ ] `grep -n "confirmed" src/server/slots.ts` shows the new transition
      (the status is now reachable)
- [ ] `bunx tsc --noEmit` exits 0; `bun run build` exits 0; `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report (do not improvise) if:
- The "Current state" excerpts don't match the live code.
- Implementing confirm appears to require changing `claimSlot`/`releaseSlot`
  behavior — that's out of scope; report the coupling.
- You're unsure whether members should be able to release confirmed slots — that's
  a product decision; ship the default (leave `releaseSlot` untouched) and flag it.

## Maintenance notes

- **Interaction with plan 004**: plan 004 deliberately leaves the `confirmed`
  badge branch in `me.tsx` alone *because of this plan*. After 009 lands, that
  branch is reachable and correct — do not let a later cleanup remove it.
- A natural follow-up: a club-wide "confirm all claimed roles" bulk action before
  a meeting, and blocking self-release of confirmed slots.
- Reviewer should confirm the confirm transition uses the conditional-update
  guard (ADR-0005 style) so it can't race a concurrent release.
