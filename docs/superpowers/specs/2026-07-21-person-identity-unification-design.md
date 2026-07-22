# One human = one Person across clubs — design

- **Date:** 2026-07-21
- **Status:** Approved (design), pending implementation plan
- **Related:** ADR-0008 (Person vs Membership), ADR-0009 (speeches), #188 (link-on-sign-in)

## Problem

A single human can end up as **multiple `people` (Person) rows**, one per club, which
fragments the person-global accomplishments the domain model promises. ADR-0008 states the
intent — "one Person per human, many memberships; person-level facts live on `people`" — and
the schema honors it: `speeches.person_id` and `path_enrollments.person_id` (and its
`path_level_progress` / `bcm_project_progress` descendants) hang off the Person, never a club or
membership. But **only the TM CSV importer** actually unifies a human into one Person (dedupe by
Customer ID → email, `import-members-logic.ts:68-134`). Two other write paths mint a **fresh
Person unconditionally**:

- `createClubWithAdmin` (superadmin "Create club") — `onboarding-logic.ts:257-278`, `user_id` left NULL.
- Bulk-import paste `applyBulkImport` — `members-logic.ts:504-574` (deliberate: "cross-club dedupe is the CSV importer's job").

Because `people.email` and `people.user_id` are **not** DB-unique, the same human accumulates
two Person rows sharing one login `user_id`. Their Pathways/speeches attach to whichever Person
a given club's ingest resolves (ingest resolves person *through* club membership,
`pathways-sync-logic.ts:39-76`), so the "global" accomplishments silently fragment. There is also
a latent hard failure: `basecamp_user_id` is globally unique, so syncing the same human in a
second club can throw a unique-constraint error.

Concrete trigger: a superadmin who provisions a club for their own email gets a **second** empty
Person; the new club's roster shows them with no speech/role/Pathways history, disconnected from
their real identity in their other club.

## Goals

1. **Prevent** new fragmentation on the write paths that have a usable identity signal.
2. **Repair** existing duplicates with a superadmin, cross-club **merge** tool.
3. Keep person-global data (speeches, Pathways) truly global once a human is one Person.

## Non-goals / validated non-issues

- **No undo / soft-delete.** Merges are irreversible; safety comes from prevention (superadmin-gated,
  confirm screen, hard blocks on ambiguous cases), not reversal.
- **Manual single-add** dedupe — the "+ Add member" button is an inert stub and the live self-add
  path (`require-member.tsx`) collects **name only**, so there is no safe key to dedupe on.
- **Bulk-import paste** stays as-is — the CSV importer remains the cross-club dedupe path.
- **No schema migration.** Every FK re-point, the audit entry (`activity_log` + `impersonated_by`),
  and detection all use existing tables/columns. (Confirm during implementation.)
- A superadmin merging **their own** two Persons is safe: the login lives on the Better-Auth `user`
  table (not `people`); the keeper retains `user_id`; deleting the absorbed `people` row does not
  touch the session.
- **Status is per-club, never global.** "Left club A, joined club B" ⇒ one Person, two memberships
  (`inactive` in A, `active` in B); each club counts its own roster independently.

## Decision log (resolved during grilling)

| # | Decision |
|---|---|
| Reversibility | No undo; prevent-only + hard blocks. |
| Two accounts | If keeper and absorbed have *differing* non-null `user_id` → **block**. Single account survives by copy regardless of direction. |
| Keeper default | Smart default (login-linked → most history → oldest `original_join_date`), superadmin can flip. |
| Detection scope | Auto-detected groups (shared case-insensitive email) **and** manual search-any-two. `customer_id` is DB-unique so it cannot be a shared-duplicate signal. |
| Create-club dedupe | **Rule B** — reuse the *best* match whenever ≥1 email match exists (same keeper heuristic). |
| Same-club collapse | Build now. Surviving membership: higher `club_role`, active-if-either `status`, earliest `joined_at`, keeper-canonical contact. |
| Pathways collision | Keep more-progressed enrollment (approved levels, tie-break fresher `last_synced_at`); self-heals on next Base Camp sync. |
| Person reconcile | Keeper canonical; adopt absorbed only where keeper null; **block** on differing non-null `user_id` / `customer_id` / `basecamp_user_id`. |
| Audit | One `member_merge` `activity_log` row per affected club, `impersonated_by` = acting superadmin. |
| Back-port | Route the existing within-club `applyMemberMerge` through the shared `collapseMemberships` helper (fixes its `officer_terms`/`member_dues` data loss). |

## Part A — Dedupe on write (prevent)

**`createClubWithAdmin`** (`onboarding-logic.ts`): before inserting the admin `people` row,
look up existing Persons by **case-insensitive email**.

- **≥1 match** → reuse the **best** Person (login-linked → most history [speeches + enrollments]
  → oldest `original_join_date`) and attach the new `admin` `members` row to it. Do **not** insert
  a new Person.
- **0 matches** → insert a new Person, as today.

Side effect (desirable): reusing an already login-linked Person makes the new club render
**"Linked"** in the console immediately (`listClubsForConsole` computes `linked = user_id != null`),
removing the "Unclaimed / must re-sign-in" confusion.

The best-match selection is the **same keeper heuristic** used by the merge tool — one consistent
notion of "which Person is the real human" — extracted into a shared helper.

## Part B — `mergePeople` (superadmin, cross-club, irreversible)

New server fn `mergePeople({ keeperPersonId, absorbedPersonId })`, superadmin-gated, one
transaction:

1. **Pre-merge validation (hard blocks), surfaced before the confirm button:**
   - `keeperPersonId === absorbedPersonId` → reject.
   - Both sides have *differing* non-null `user_id` → reject ("resolve accounts first").
   - Both sides have *differing* non-null `customer_id` → reject (different humans).
   - Both sides have *differing* non-null `basecamp_user_id` → reject (different humans).
2. **Person-level reconcile** on the keeper `people` row:
   - `name` — keeper's (canonical).
   - `email`, `phone`, `customer_id`, `basecamp_user_id`, `user_id` — keeper's; adopt absorbed's
     only where keeper's is null.
   - `original_join_date` — earliest non-null.
3. **Memberships** — for each club the absorbed Person has a membership in:
   - keeper is **also** a member of that club → `collapseMemberships(keeperMembership, absorbedMembership, tx)`.
   - otherwise → re-point `members.person_id` absorbed → keeper.
4. **Speeches** — re-point `speeches.person_id` absorbed → keeper (no unique constraint; no collision).
5. **Path enrollments** — for each absorbed enrollment:
   - keeper already enrolled in the same `path_id` (unique `(person_id, path_id)`) → keep the
     **more-progressed** enrollment (most `approved` levels, tie-break fresher `last_synced_at`);
     delete the loser (its `path_level_progress` + `bcm_project_progress` cascade away).
   - otherwise → re-point `path_enrollments.person_id` absorbed → keeper.
6. **Delete** the absorbed `people` row.
7. **Audit** — one `member_merge` `activity_log` row per **club where a membership was re-pointed
   or collapsed**: `actor_member_id = NULL`, `impersonated_by = <superadmin user id>`,
   `target_type = 'member'`, `detail = { keeperPersonId, absorbedPersonId, movedCounts }`. Uses the
   existing `member_merge` action enum + nullable `impersonated_by` — no migration.
   *Edge:* a merge that changes no membership (absorbed had only person-owned speeches/drafts, no
   roster row) has no club to key an audit row on; that case writes no club-scoped audit entry
   (acceptable — rare, and `movedCounts` there is memberships = 0).

### `collapseMemberships(keeperMembershipId, absorbedMembershipId, tx)` — shared helper

Used by `mergePeople` (same-club branch) **and** back-ported into the existing within-club
`applyMemberMerge`.

**Surviving (keeper) membership fields:**

| Field | Rule |
|---|---|
| `club_role` | Higher wins (`admin` > `member`) |
| `status` | `active` if either is active |
| `joined_at` | Earliest non-null |
| `name` / `email` / `phone` | Keeper's; fill nulls from absorbed |

**Re-point all 10 membership FKs** absorbed → keeper:

| Table.column | On-delete | Collision handling |
|---|---|---|
| `officer_terms.membership_id` | cascade | Re-point; if two *open* terms for one position result, keep earliest-start |
| `member_dues.membership_id` | cascade | Unique `(membership, period)` → keeper's row wins, drop absorbed dup |
| `member_availability.member_id` | cascade | Unique `(member, meeting)` → keeper wins, drop absorbed dup |
| `notifications.assigned_member_id` | cascade | Unique `(slot, member)` → keeper wins, drop absorbed dup |
| `role_slots.assigned_member_id` | set null | Re-point (no member-level unique) |
| `meeting_attendance.member_id` | set null | Unique `(meeting, member)` → keeper wins, drop absorbed dup |
| `table_topics_speakers.member_id` | set null | Re-point (no member-level unique) |
| `meeting_awards.member_id` | set null | Unique `(meeting, category)` → keeper wins, drop absorbed dup |
| `guests.converted_membership_id` | set null | Re-point |
| `activity_log.actor_member_id` | set null | Re-point column **and** `jsonb_set` on `detail.memberId` / `detail.fromMemberId` |

Then **delete** the absorbed `members` row.

> **Back-port note:** the current `applyMemberMerge` (`members-logic.ts:324-403`) manually re-points
> only `role_slots`, `member_availability`, and `activity_log`, then deletes the absorbed member and
> lets the DB cascade the rest — which **cascade-deletes** `officer_terms` and `member_dues` (data
> loss) and orphans the absorbed Person. Routing it through `collapseMemberships` fixes both; its
> existing tests are updated to assert the now-preserved rows.

## Part C — Superadmin "Duplicate people" UI

New section in the superadmin console (`src/routes/_authed/superadmin/…`).

- **Auto-detected groups:** Persons sharing a case-insensitive email across clubs. Each group shows
  the Person rows with their clubs, speech/enrollment counts, and which is login-linked. The keeper
  is pre-selected by the smart default and can be flipped. A confirm screen shows exactly what will
  move ("2 memberships, 5 speeches, 1 enrollment → keeper"); any hard block is shown inline and
  disables merge.
- **Manual search-and-merge:** search Persons by name/email, pick any two, run the identical
  confirm → merge path. Covers email-less and different-email duplicates (the only way to fix them
  without a DB script).

## Testing

Follow the repo pattern: directly testable logic lives in `*-logic.ts`, exercised by Vitest;
server-fn wrappers export only `createServerFn`s (server-modules guard).

**Pure-logic unit tests:**
- Create-club dedupe: 0 / 1 / ≥2 email matches; best-match selection order (linked > history > age).
- `mergePeople`: clean cross-club (3 person FKs re-pointed, absorbed deleted); each hard block
  (same id, differing `user_id` / `customer_id` / `basecamp_user_id`); person-field reconcile
  (adopt-if-null, earliest join date); path-collision keep-more-progressed + re-point of
  absorbed-only paths; per-affected-club audit rows.
- `collapseMemberships`: all 10 FK re-points; each unique-collision keeper-wins/drop-dup; surviving
  membership reconcile (higher role, active-if-either, earliest join); **officer_terms + member_dues
  preserved** (the back-port regression); `activity_log.detail` jsonb re-point.
- Existing `applyMemberMerge` tests updated for the preserved rows.

**Integration test (real Postgres, `tm_test`):** the full `mergePeople` transaction end-to-end,
including a same-club-collapse case, asserting FK integrity and no orphaned rows.

## Rollout order

1. Part A (create-club dedupe) + shared best-match helper — unbreaks the self-provisioning case.
2. `collapseMemberships` helper + `mergePeople` clean cross-club branch + Part C detection/merge UI.
3. Same-club collapse + path-collision handling + back-port of `applyMemberMerge`.
4. Integration tests.

## Key files

- `src/server/onboarding-logic.ts` — `createClubWithAdmin` (Part A), `listClubsForConsole`.
- `src/server/members-logic.ts` — `applyMemberMerge` (back-port), new `collapseMemberships` / `mergePeople` logic (or a new `person-merge-logic.ts`).
- `src/server/members.ts` — `mergeMembers` server fn (routes through helper).
- `src/server/account-link-logic.ts` — `linkPersonToUser` (context; unchanged).
- `src/routes/_authed/superadmin/index.tsx` / `$clubId.tsx` — console + new duplicate-people UI (Part C).
- `src/db/schema.ts` — reference only (no migration expected).
