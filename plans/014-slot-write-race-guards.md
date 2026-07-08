# Plan 014: Restore the ADR-0005 race guard on every slot-assigning write

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6a37548..HEAD -- src/server/speeches-logic.ts src/server/slots.ts src/server/slots-logic.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `6a37548`, 2026-07-08
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/125

## Why this matters

The repo's core concurrency invariant (CONTEXT.md "Invariants", ADR-0005) is:
*"A slot moves to `claimed` only via a conditional update guarding against
double-claims. Never set `assigned_user_id` without that guard."* `claimSlot`
honors it. Two newer write paths do not:

1. `attachSpeechToOpenSlot` (`src/server/speeches-logic.ts`) — the path behind
   the `rescheduleSpeech` server fn (attaching an unscheduled speech to an open
   speaker slot). It SELECT-checks the slot is open, then UPDATEs by id only.
   Two concurrent reschedules of *different* speeches onto the same slot both
   pass the in-memory check and both report success; last writer wins. A
   member's concurrent `claimSlot` can also be silently clobbered.
2. `reassignSlot` (`src/server/slots.ts`) — reads the slot and the outgoing
   assignee's Person *before* opening its transaction, then UPDATEs by id only.
   A concurrent release/claim/reassign between the read and the write is
   silently overwritten, and the speech keep-or-unlink decision is made from a
   stale prior assignee.

Both are check-then-act races on the app's central shared resource. The fix is
mechanical: make the final UPDATE conditional (pattern already in `claimSlot`),
and move `reassignSlot`'s reads inside its transaction with a row lock.

## Current state

Relevant files:

- `src/server/speeches-logic.ts` — pure DB logic for speeches (testable, takes
  a `DbOrTx` conn). `attachSpeechToOpenSlot` is at lines 220–306.
- `src/server/speeches.ts` — server-fn wrappers only. `rescheduleSpeech`
  (line 71) wraps `attachSpeechToOpenSlot` in `db.transaction` (lines 86–87).
- `src/server/slots.ts` — slot server fns. `claimSlot` (line 42) has the
  correct guard; `reassignSlot` (line 298) does not.
- `src/server/slots-logic.ts` — sibling logic module; `reassignSlotSpeech` is
  at line 321. New extracted logic goes here.

The **correct** pattern, from `claimSlot` (`src/server/slots.ts:67-81`):

```ts
return db.transaction(async (tx) => {
	// Conditional UPDATE is the race guard: only one claim can flip 'open'.
	const updated = await tx
		.update(roleSlots)
		.set({
			assignedMemberId: data.memberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "open")))
		.returning({ id: roleSlots.id });

	if (updated.length === 0) {
		throw new Error("Sorry — this role was just claimed by someone else.");
	}
```

The **broken** write in `attachSpeechToOpenSlot`
(`src/server/speeches-logic.ts:286-294`) — after SELECT-based prechecks at
lines 249–261 (`slot.speechId` null, `slot.assignedMemberId` null, speaker
role, meeting not cancelled):

```ts
	await conn
		.update(roleSlots)
		.set({
			assignedMemberId: membership.id,
			status: "claimed",
			claimedAt: new Date(),
			speechId: args.speechId,
		})
		.where(eq(roleSlots.id, args.slotId));
```

The **broken** flow in `reassignSlot` (`src/server/slots.ts:301-349`): the slot
row and `fromPerson`/`toPerson` are resolved at lines 301–342 (outside any
transaction), then:

```ts
	return db.transaction(async (tx) => {
		// New holder hasn't been confirmed → back to "claimed".
		await tx
			.update(roleSlots)
			.set({ assignedMemberId: data.memberId, status: "claimed" })
			.where(eq(roleSlots.id, data.slotId));

		// Unlink the speech only when the Person actually changed.
		if (slot.isSpeakerRole) {
			await reassignSlotSpeech(tx, {
				slotId: data.slotId,
				fromPersonId: fromPerson,
				toPersonId: toPerson,
			});
		}
```

Conventions that apply:

- Server-fn modules (`speeches.ts`, `slots.ts`) may export ONLY
  `createServerFn`s and types — enforced by
  `src/server/server-modules.guard.test.ts`. Directly-testable DB logic
  belongs in the sibling `*-logic.ts` (see `members-logic.ts`). If you extract
  anything from `slots.ts`, it goes in `slots-logic.ts`.
- Error messages are user-facing sentences (match the existing
  "Sorry — this role was just claimed by someone else." style).
- Biome formats with tabs and double quotes; `bun run check` gates it.
- **Semantics to preserve**: `reassignSlot` is deliberately allowed to assign
  an *open* slot (admin/VPE assign-to-member flows use it). Do NOT add a
  status precondition to it — the fix is atomicity (read and write inside one
  transaction with a row lock), not a new restriction.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `bun install` | exit 0 |
| Lint/format | `bun run check` | exit 0 |
| Typecheck | `bunx tsc --noEmit` | exit 0, no output |
| All tests | `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test` | all pass, 0 fail |
| One suite | `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/speech-lifecycle.integration.test.ts` | all pass |

Notes: the integration suites skip silently without `TEST_DATABASE_URL`. The
local test DB `tm_test` lives in the already-running `dev-postgres` Docker
container (`postgres:17` on :5432) — do NOT start a new Postgres container.
If the credentials above fail, check `docker exec dev-postgres psql -U dev -l`
and adjust user/password to what the container uses.

## Scope

**In scope** (the only files you should modify):

- `src/server/speeches-logic.ts`
- `src/server/slots.ts`
- `src/server/slots-logic.ts`
- `src/server/speech-lifecycle.integration.test.ts` (add tests)
- One new or existing integration test file for the reassign logic (e.g.
  extend `src/server/roster-mgmt.integration.test.ts` or create
  `src/server/reassign.integration.test.ts`)

**Out of scope** (do NOT touch, even though they look related):

- `claimSlot` / `confirmSlot` / `unconfirmSlot` in `src/server/slots.ts` —
  already correct.
- `src/server/speeches.ts` — the `rescheduleSpeech` wrapper is fine as-is.
- Any UI component (`assign-slot-sheet.tsx`, route files).
- The slot status state machine itself (no new statuses, no new rules).

## Git workflow

- Branch: `advisor/014-slot-write-race-guards` (create a dedicated git
  worktree first — this repo requires worktree isolation for edits; see
  CLAUDE.md "Git worktree isolation". A fresh worktree needs `bun install`
  and a copied `.env.local` before DB commands work.)
- Commit style: conventional commits, e.g.
  `fix(slots): conditional-update race guards on attach + reassign (ADR-0005)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Guard the final UPDATE in `attachSpeechToOpenSlot`

In `src/server/speeches-logic.ts`, change the assign UPDATE (lines 286–294) to
a conditional update + zero-row check. Add `isNull` to the existing
`drizzle-orm` import if not present. Target shape:

```ts
	const updated = await conn
		.update(roleSlots)
		.set({
			assignedMemberId: membership.id,
			status: "claimed",
			claimedAt: new Date(),
			speechId: args.speechId,
		})
		.where(
			and(
				eq(roleSlots.id, args.slotId),
				eq(roleSlots.status, "open"),
				isNull(roleSlots.assignedMemberId),
				isNull(roleSlots.speechId),
			),
		)
		.returning({ id: roleSlots.id });
	if (updated.length === 0) {
		throw new Error("That speaker slot was just claimed by someone else.");
	}
```

Keep the existing prechecks (they produce the specific, friendlier error
messages); the conditional UPDATE is the last-line guard. Keep the
unlink-other-slots step (lines 281–284) exactly where it is.

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 2: Extract `reassignSlot`'s core into `slots-logic.ts` and make it atomic

Create an exported function in `src/server/slots-logic.ts` (place it near
`reassignSlotSpeech`, line 321):

```ts
export async function reassignSlotCore(
	tx: DbOrTx,
	args: { slotId: string; memberId: string; actorMemberId: string | null },
): Promise<{ clubId: string }> { ... }
```

Inside it, in this order:

1. Re-select the slot **with a row lock** so the read and write are atomic:
   the same joined SELECT `reassignSlot` does today (slot id/status/
   assignedMemberId/isSpeakerRole + meeting clubId) but via `tx` and with
   `.for("update", { of: roleSlots })` (drizzle supports `.for()` on selects;
   lock only `roleSlots` — `FOR UPDATE` on the joined `role_definitions`/
   `meetings` rows is unnecessary). Throw `"Role not found."` on no row.
2. Resolve `fromPerson` (from the *locked* row's `assignedMemberId`) and
   `toPerson` via `tx` — move the existing `personOf` helper logic here.
3. Run the UPDATE (`assignedMemberId`, `status: "claimed"`) via `tx`.
4. Call `reassignSlotSpeech(tx, ...)` when `isSpeakerRole`, as today.
5. Keep the activity-log call (`logActivity`) if it currently lives inside the
   transaction; check the remainder of the handler (lines 350–383) and move
   everything transaction-scoped into the core function.

Then shrink the `reassignSlot` handler in `src/server/slots.ts` to: zod
validation (unchanged) → the two `requireMemberInClub` trust guards
(unchanged — they need the clubId, so either keep the cheap pre-read of the
slot for the guards, or have `reassignSlotCore` verify membership itself; the
simplest correct shape is to keep the existing pre-read *solely* to get
`clubId` for the guards, then let `reassignSlotCore` re-read with the lock) →
`db.transaction((tx) => reassignSlotCore(tx, {...}))`.

**Verify**: `bun run check` → exit 0; `bunx tsc --noEmit` → exit 0. Also
`TEST_DATABASE_URL=… bun run test` → the guard test
`server-modules.guard.test.ts` still passes (slots.ts exports unchanged).

### Step 3: Integration tests

See "Test plan" below.

**Verify**: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test` → all pass, including the new tests.

### Step 4: Full gate

**Verify**: `bun run check` → exit 0; `bunx tsc --noEmit` → exit 0;
`TEST_DATABASE_URL=… bun run test` → 0 failures; `bun run build` → exit 0.

## Test plan

Model the setup/teardown after `src/server/speech-lifecycle.integration.test.ts`
(it already builds clubs/members/meetings/slots/speeches against `testDb` from
`src/test/db.ts`, and skips without `TEST_DATABASE_URL`).

New cases:

1. **Concurrent attach race** (in `speech-lifecycle.integration.test.ts`):
   create ONE open speaker slot and TWO unscheduled speeches (different
   Persons, both active members). Run
   `Promise.allSettled([attachSpeechToOpenSlot(testDb, {speechA…}), attachSpeechToOpenSlot(testDb, {speechB…})])`.
   Assert exactly one fulfilled and one rejected, and that the slot ends with
   the winner's `speechId`/`assignedMemberId` and `status = "claimed"`.
   (Passing `testDb` directly — not a transaction — is what lets the two calls
   actually interleave.)
2. **Attach onto a just-claimed slot**: pre-set the slot to
   `status = "claimed"` with an assignee directly via `testDb.update`, then
   assert `attachSpeechToOpenSlot` rejects (either precheck or guard message).
3. **Reassign atomicity** (new/extended suite for `reassignSlotCore`):
   (a) plain reassign open→member works and sets `status = "claimed"` —
   guards the preserved open-assign semantics; (b) reassign of a speaker slot
   to a different Person unlinks the speech, same Person keeps it (exercise
   `reassignSlotSpeech` through the new core fn); (c) two concurrent
   `reassignSlotCore` calls in separate `testDb.transaction(...)`s on the same
   slot both complete without error (last writer wins is acceptable for
   admin-trust reassign) and the final state is exactly one of the two
   targets with its correct speech linkage — no torn state where the assignee
   is A but the speech decision was computed from a pre-race assignee.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `TEST_DATABASE_URL=… bun run test` exits 0; the new race tests exist and pass
- [ ] `grep -n "returning" src/server/speeches-logic.ts` shows the attach UPDATE now returns rows (guarded)
- [ ] `grep -c "for(\"update\"" src/server/slots-logic.ts` ≥ 1 (or the drizzle `.for("update"` call in whatever formatting Biome produces)
- [ ] `bun run build` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts above.
- Drizzle's `.for("update")` is unavailable or fails on the joined select in
  your installed drizzle-orm version — report the error rather than switching
  to raw SQL.
- Preserving the `requireMemberInClub` guards requires touching
  `src/server/guards.ts`.
- The concurrent-attach test cannot produce a deterministic single-winner
  outcome after two attempts at test design.

## Maintenance notes

- Any FUTURE code path that sets `roleSlots.assignedMemberId` or
  `roleSlots.speechId` must use a conditional UPDATE (or a `FOR UPDATE`-locked
  read-then-write in one transaction). Reviewers: grep new PRs for
  `.set({ assignedMemberId` and check the `where` clause.
- `reassignSlot` deliberately allows assigning open slots (admin flows). If a
  product decision later restricts that, the restriction belongs in
  `reassignSlotCore` with its own test.
- Plan 020 (reminders) adds notification writes inside `claimSlot`/
  `releaseSlot`/`reassignSlot` transactions — if it lands after this plan, its
  reassign write point belongs inside `reassignSlotCore`.
