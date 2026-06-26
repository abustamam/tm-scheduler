# Plan 008: Design spike — VP Education dashboard (rotation / overdue / speaker queue)

> **Executor instructions**: This is a **design/spike plan**, not a build-it-all
> plan. The deliverable is a short written design doc plus a couple of proven
> read-only query prototypes — NOT a finished feature. Do not build UI beyond a
> minimal proof. If anything in "STOP conditions" occurs, stop and report. When
> done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/db/schema.ts src/server/meetings.ts docs/adr/0005-role-slots-source-of-truth.md`

## Status

- **Priority**: P3
- **Effort**: M (spike)
- **Risk**: LOW
- **Depends on**: none (benefits from 001's Vitest harness if you prototype with tests)
- **Category**: direction
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/8 (pre-existing build issue; this plan is the design spike that precedes it — no duplicate filed)

## Why this matters

ADR-0005 explicitly designed `role_slots` to be the history table so that "the
Phase-3 VP Education dashboard (speaker queue, rotation, overdue members) needs
no new tables — only queries over `role_slots`." That dashboard is the most
grounded next feature: the data model was *built* for it, and a VPE's core job
(making sure roles rotate fairly and nobody is overdue to speak) is exactly the
manual work the app set out to replace. This spike verifies the "no new tables"
claim by prototyping the key queries and defines the feature's scope before
anyone commits to building it.

## Current state / grounding

- `docs/adr/0005-role-slots-source-of-truth.md` — "History — 'who has done what /
  who's overdue' is a query over slots of past meetings. No separate history
  table." and "The Phase-3 VP Education dashboard … needs no new tables — only
  queries over `role_slots`."
- `CONTEXT.md:38-39` — lists "role-rotation fairness" and "Pathways progress
  dashboards" as explicitly **out of scope for the MVP** (later phases). So this
  is a future phase being de-risked, not MVP scope creep.
- Schema (`src/db/schema.ts`): `roleSlots(meetingId, roleDefinitionId,
  assignedUserId, status, claimedAt)`; `meetings(clubId, scheduledAt, status)`;
  `roleDefinitions(clubId, name, category, isSpeakerRole)`; `clubMemberships(userId,
  clubId, clubRole, status)`; `user(id, name, email)`. "Past meetings" =
  `meetings.scheduledAt < now()` and `status != 'cancelled'`.
- Existing query patterns to imitate live in `src/server/meetings.ts` (Drizzle
  `select`/`join`/`groupBy`, `createServerFn` with a `requireClubRole` guard).
- Authorization model (CONTEXT.md "Invariants"): this dashboard is VPE/admin-only
  — gate with `requireClubRole(userId, clubId, ["admin", "vpe"])`.

## Deliverables

1. A design doc at `docs/design/vpe-dashboard.md` (create the `docs/design/`
   folder) covering the items in "Scope of the design" below.
2. Proven SQL/Drizzle prototypes for the three core queries (in the doc as code
   blocks, optionally backed by a throwaway test against seed data).
3. An explicit confirmation (or refutation) of ADR-0005's "no new tables" claim.

## Scope of the design (what the doc must answer)

For each of the three dashboard pieces, the doc specifies the query, its inputs,
and the shape returned:

- **Speaker queue / rotation** — for a club, rank active members by how recently
  (or how many times) they've held a **speaker** role (`isSpeakerRole = true`)
  in past meetings. Surfaces who's "up next." Query over `roleSlots` joined to
  `roleDefinitions` (speaker filter), `meetings` (past), grouped by
  `assignedUserId`, with members who have *never* spoken included (left join from
  `clubMemberships`).
- **Overdue members** — active members who haven't held *any* role in the last N
  meetings or M days. Define "overdue" precisely (pick a default, e.g. no claimed
  slot in the last 60 days) and make it a parameter.
- **Per-member history** — for one member, their past roles with meeting dates
  (drives a member detail view). Straight select over `roleSlots` for
  `assignedUserId`, past meetings, ordered by date.

Also address:
- **Where it lives**: a new `src/server/reporting.ts` (server fns, VPE-gated) and
  a new route under `src/routes/_authed/admin/` (mirror
  `admin/meetings.new.tsx`'s `beforeLoad` role guard).
- **Performance**: confirm the indexes that exist
  (`role_slots_assigned_user_idx`, `meetings_club_scheduled_idx`) cover these
  access paths; flag any missing index as a follow-up (do not add it in the
  spike).
- **Open questions** for the maintainer (e.g. does "overdue" count functionary
  roles or only speaking? is rotation per-role or global?).

## Commands you will need

| Purpose      | Command                                   | Expected |
|--------------|-------------------------------------------|----------|
| Typecheck    | `bunx tsc --noEmit`                        | exit 0 (if you write any `.ts` prototype) |
| Inspect data | `bun run db:studio`                       | opens Drizzle Studio |
| Seed sample  | `bun run db:seed`                         | seeds club MCF |
| Prototype run| `bunx vitest run <prototype>.test.ts`     | passes (if you test the query) |

## Scope

**In scope** (create):
- `docs/design/vpe-dashboard.md`
- Optionally `src/server/reporting.prototype.test.ts` (a throwaway query
  prototype against seed data — clearly named as a prototype, or deleted after
  the numbers are captured into the doc).

**Out of scope** (do NOT build in this spike):
- The actual dashboard route/UI beyond, at most, a paragraph describing it.
- Any schema change or migration. The whole point is to confirm none is needed —
  if you believe one IS needed, that's the key finding to report, not to
  implement.
- Pathways progress tracking (separate later phase per CONTEXT.md).

## Git workflow

- Branch: `advisor/008-spike-vpe-dashboard`
- Conventional commit, e.g. `docs: design spike for VPE dashboard`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Seed and explore

`bun run db:seed`, then use `bun run db:studio` (or ad-hoc queries) to look at
the `role_slots` / `meetings` / `club_memberships` data for club MCF. Note that
the seed creates meetings in the **future**; to prototype "past meeting" queries
you may need to insert a past-dated meeting in your dev DB (do not commit it).

### Step 2: Prototype the three queries

Write each query (Drizzle or raw SQL) and run it against the dev data. Capture
the exact query and a sample result into the design doc. Confirm each needs only
existing tables.

### Step 3: Write `docs/design/vpe-dashboard.md`

Fill in every item under "Scope of the design," the proven queries, the
index/performance notes, and the open questions. End with a clear verdict on
ADR-0005's "no new tables" claim.

**Verify**: the doc exists and contains the three queries and the verdict;
`bunx tsc --noEmit` exits 0 if any `.ts` was added.

## Done criteria

ALL must hold:

- [ ] `docs/design/vpe-dashboard.md` exists with: 3 prototyped queries, the
      proposed file/route layout, index/perf notes, open questions, and an
      explicit "no new tables: confirmed/refuted" verdict
- [ ] If any prototype `.ts`/test was committed, `bunx tsc --noEmit` exits 0
- [ ] No schema/migration files changed (`git status`)
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report (do not improvise) if:
- A core query genuinely **cannot** be expressed over existing tables without a
  new table or column — that contradicts ADR-0005 and is the most important
  thing to surface; report it rather than adding schema.
- The existing indexes clearly can't support a query pattern at realistic scale —
  note it as a follow-up; don't add indexes in the spike.

## Maintenance notes

- This spike's output (the design doc) becomes the input to a future build plan.
- If the verdict is "needs a new column/index," that should become its own
  schema plan reviewed against ADR-0005 (the doc would be amending a decision).
- Reviewer should check the queries actually run and the "overdue" definition is
  one the VPE would agree with (it's a product judgment, flagged as an open
  question for a reason).
