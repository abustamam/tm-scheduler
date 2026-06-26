# Plan 002: DB-backed integration tests for the claim race guard and authorization guards

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/server/slots.ts src/server/guards.ts src/server/meetings.ts`
> If any in-scope source file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-extract-pure-agenda-logic.md (for the Vitest config + `#/` alias)
- **Category**: tests
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/3 (pre-existing — this plan is the detailed spec for it; no duplicate filed)

## Why this matters

The single most important invariant in this app is that **two members can never
claim the same role slot** — ADR-0005 calls this the "concurrency boundary" and
it is the headline reason the app beats the shared spreadsheet. It is enforced
by one conditional `UPDATE ... WHERE id = ? AND status = 'open'` inside a
transaction (`src/server/slots.ts:58-72`). That logic, plus the authorization
guards in `src/server/guards.ts`, has **zero test coverage**. A regression here
is silent and corrupts the core product promise. This plan adds integration
tests that exercise the real Drizzle/Postgres path against a throwaway test
database.

These tests are DB-backed by necessity: the race guard *is* a database
constraint, so it can't be unit-tested in isolation. There is no SQLite/PGLite
shortcut because the app uses `drizzle-orm/node-postgres` (the `pg` driver) — a
real Postgres is required (the repo already assumes Docker Postgres for dev; see
`README.md:27-30`).

## Current state

The race guard (`src/server/slots.ts:58-72`):

```ts
return db.transaction(async (tx) => {
	const updated = await tx
		.update(roleSlots)
		.set({ assignedUserId: currentUser.id, status: "claimed", claimedAt: new Date() })
		.where(and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "open")))
		.returning({ id: roleSlots.id });
	if (updated.length === 0) {
		throw new Error("Sorry — this role was just claimed by someone else.");
	}
	// ... speaker details upsert ...
});
```

The guards (`src/server/guards.ts:31-65`): `getMembership`, `requireMembership`
(throws unless an **active** membership exists), `requireClubRole` (throws unless
the membership's `club_role` is in the allowed list).

Important architectural constraint (`CONTEXT.md:47`, `guards.ts:7-11`): server
modules import `auth`/`getRequest`, which read the HTTP request. The exported
server functions (`claimSlot`, `releaseSlot`) call `requireUser()`, which depends
on a live request via `getRequest()` / `auth.api.getSession`. **Those request-bound
functions cannot run in a plain Vitest process.**

Therefore this plan tests at the **Drizzle layer**, not through the
`createServerFn` wrappers: it reproduces the exact claim transaction and the
guard helpers against a test DB, asserting the conditional-update behavior and
the membership/role checks. `requireUser` (request-bound) is explicitly out of
scope — note that gap in the maintenance section.

Schema facts the tests need (`src/db/schema.ts`):
- `clubs(id uuid pk, name)`, `clubMemberships(userId text, clubId uuid, clubRole enum admin|vpe|member, status enum active|inactive)`.
- `user(id text pk, name, email unique, emailVerified)` (from `src/db/auth-schema.ts`).
- `meetings(id uuid pk, clubId, scheduledAt, status)`, `roleDefinitions(id uuid pk, clubId, name, category, defaultCount, isSpeakerRole)`, `roleSlots(id uuid pk, meetingId, roleDefinitionId, status enum open|claimed|confirmed, assignedUserId, claimedAt)`.

Conventions: tabs + double quotes (Biome), `#/` alias, strict TS.

## Commands you will need

| Purpose         | Command                                              | Expected on success     |
|-----------------|------------------------------------------------------|-------------------------|
| Start test PG   | `docker run -d --name tm-pg-test -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tm_test postgres:17` | container id |
| Push schema     | `DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx drizzle-kit push` | "Changes applied" |
| Typecheck       | `bunx tsc --noEmit`                                  | exit 0                  |
| Run these tests | `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run src/server/claim.integration.test.ts` | all pass |
| Lint/fmt        | `bun run check`                                      | exit 0                  |

If Docker is unavailable, any reachable Postgres 17 works — set
`TEST_DATABASE_URL` accordingly. **Never point `TEST_DATABASE_URL` at the dev or
prod database** — the tests insert and delete club rows.

## Scope

**In scope** (create/modify):
- `src/server/claim.integration.test.ts` (create) — the race + guard tests.
- `src/test/db.ts` (create) — a tiny helper that builds a Drizzle client from
  `TEST_DATABASE_URL` and exposes cleanup utilities.
- `vitest.config.ts` (modify only if needed to load `.env`/env for the test run).

**Out of scope** (do NOT touch):
- `src/db/index.ts` — the production client reads `DATABASE_URL`; do not make it
  read the test URL. The test helper builds its own client.
- `src/server/slots.ts`, `guards.ts`, `meetings.ts` — no source changes; this
  plan only adds tests. (If a test reveals a real bug, STOP and report it
  rather than fixing inline.)
- Any `createServerFn` wrapper or request-bound code (`requireUser`).

## Git workflow

- Branch: `advisor/002-integration-tests`
- Conventional commits, e.g. `test: integration tests for claim race + guards`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Test DB helper

Create `src/test/db.ts` that:
- Reads `process.env.TEST_DATABASE_URL`; if absent, throws a clear error telling
  the runner to set it (so the suite fails loudly rather than hitting dev data).
- Exports a Drizzle client built the same way as production but from that URL:
  `drizzle(process.env.TEST_DATABASE_URL!, { schema })` importing `* as schema`
  from `#/db/schema`.
- Exports a `seedClub()` helper that inserts: one club, one admin user + one
  member user + their active memberships, one role definition
  (`isSpeakerRole: false`, e.g. "Timer"), one meeting, and one **open**
  `roleSlots` row; returns their ids. Use `node:crypto` `randomUUID()` for the
  `user.id` text PKs (matching `src/db/seed.ts:87-93`).
- Exports a `cleanup(clubId)` that deletes the club (cascades to meetings, slots,
  role defs, memberships) and deletes the test users by id.

### Step 2: Race-guard test

Create `src/server/claim.integration.test.ts`. In a `beforeEach`, call
`seedClub()`; in `afterEach`, `cleanup()`. Write the **conditional-update
transaction inline in the test** (it mirrors `slots.ts:58-72`) and assert:

- **Happy path**: claiming an `open` slot updates exactly 1 row, sets
  `status='claimed'` and `assignedUserId`.
- **Race**: fire two claim transactions for the *same* slot with two different
  users concurrently (`await Promise.allSettled([claimA, claimB])`). Exactly one
  `returning()` yields a row; the other yields `[]`. After settling, the slot's
  `assignedUserId` is exactly one of the two users and `status='claimed'`.
- **Double claim sequentially**: a second claim on an already-claimed slot
  returns `[]` (the guard rejects it).

### Step 3: Guard tests

In the same file (or `src/server/guards.integration.test.ts` — your choice, keep
it consistent), import the real guard helpers that are **not** request-bound:
`getMembership`, and test `requireMembership` / `requireClubRole` behavior by
calling them with the seeded ids. Note: `requireMembership` and `requireClubRole`
take `(userId, clubId, ...)` and use the production `db` (which reads
`DATABASE_URL`). To avoid coupling to `DATABASE_URL`, **replicate the guard
predicates in the test using the test client** rather than importing the
request-bound module — assert:

- An active member resolves a membership; an inactive membership is treated as
  not-a-member (`requireMembership` throws — replicate: `status !== 'active'`).
- A `member` role is rejected by a `['admin','vpe']` check; an `admin` passes.

(Keep these as straightforward assertions over rows the test client reads; the
goal is to lock the access rules in CONTEXT.md "Invariants" into a test.)

**Verify after Steps 2–3**:
`TEST_DATABASE_URL=... bunx vitest run src/server/claim.integration.test.ts`
→ all pass.

## Test plan

- Cases: happy claim, concurrent race (exactly-one-winner), sequential
  double-claim rejection, active vs inactive membership, member vs admin role.
- No existing integration test to model after; structure with Vitest
  `describe`/`beforeEach`/`afterEach`/`it`.
- Verification: the command in Step 3 → all pass; intentionally break the
  `status = 'open'` predicate locally to confirm the race test would catch a
  regression, then revert.

## Done criteria

ALL must hold:

- [ ] `TEST_DATABASE_URL=... bunx vitest run src/server/claim.integration.test.ts` exits 0
- [ ] The race test asserts exactly one of two concurrent claims wins
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run check` exits 0
- [ ] No source files under `src/server/` (other than new `*.test.ts`) or
      `src/db/` are modified (`git status`)
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report (do not improvise) if:
- No Postgres is reachable and Docker cannot be started — report that the tests
  need a `TEST_DATABASE_URL`; do not fall back to the dev/prod DB.
- A test reveals the race guard does NOT actually prevent double-claims — that's
  a real bug; report it, do not patch `slots.ts` in this plan.
- The Vitest config from plan 001 does not exist yet — this plan depends on it.

## Maintenance notes

- **Coverage gap left open on purpose**: the request-bound path (`requireUser`
  via `getRequest`/`auth.api.getSession`, and the `createServerFn` wrappers) is
  not covered here because it needs a live HTTP request. A future plan could add
  Playwright/HTTP-level tests, or refactor the server fns to accept an injected
  user so the wrappers become testable.
- If `slots.ts` ever moves the claim out of a single conditional UPDATE (e.g. to
  a read-then-write), these tests must be revisited — that change would
  reintroduce the race ADR-0005 forbids.
- Reviewer should confirm the test never points at `DATABASE_URL` and always
  cleans up its club rows.
