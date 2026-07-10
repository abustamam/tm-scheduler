# Add a role to existing meetings (#143)

## Problem: template drift

A club's role template **is** its standard set of roles, and every meeting is
meant to be that standard set. Slots are generated from the template **only at
meeting creation** (`applyCreateMeeting`, `src/server/meetings-logic.ts:34–57`).

The bug is **drift**: when you update the standard set *after* meetings already
exist, those meetings no longer match. Concretely — you realize "Vote Counter"
was missing, add it to the template, and now there is no way to get it onto the
meetings you already created. (`applyRoleDefinitionCreate` only affects *future*
meetings; the meeting view's only add/remove is hardwired to the speaker+evaluator
pair via `applyAddSpeakerSlot`.)

Two shapes of the same problem:

- **Standard role missing everywhere** (Vote Counter) — should be on every meeting,
  so it lives in the template with `defaultCount ≥ 1` and needs backfilling onto
  existing meetings.
- **One-off / occasional role** (a guest "Jokemaster" this week, a second speaker)
  — belongs on a single meeting, not the standard set (`defaultCount = 0`, or just
  a duplicate of an existing role).

## Model & decisions (from brainstorming + grilling)

**One coherent rule:** the paired **speaker + evaluator** are per-meeting only
(managed by the existing "+ Add speaker" / "− Remove speaker" pair buttons);
**every other standard role is template-generated and template-synced.**

1. **Two surfaces:** a per-meeting add/remove primitive, and a club-level template
   sync. Both admin/VPE only (`requireClubRole(user.id, clubId, ["admin"])`).
2. **Per-meeting add:** add any role *except* the speaker and its paired evaluator;
   duplicates allowed (a second Timer renders "Timer 2", appended to its category
   section — slots order by `roleDefinitions.sortOrder` then `slotIndex`,
   `meetings.ts:116`). No date gate — works on past meetings too (historical
   correction).
3. **Per-meeting remove:** a per-slot remove control on **unclaimed, non-paired**
   slots (generalizing the speaker-only remove that exists today). Only unclaimed
   slots are removable — a claimed assignment never shows the control. Also unblocks
   role deletion: clear the slots, then `deleteClubRole` succeeds. Speakers/paired
   evaluators keep the pair buttons; they get no per-slot control.
4. **Bulk = template sync, presence-based:** one action, "Update upcoming meetings
   to match." For each upcoming meeting it adds one slot of every **standard,
   non-paired role the meeting has zero of**. Never tops up counts (so a
   deliberately-reduced count is left alone), never touches speakers/paired
   evaluators, never removes anything — always safe and idempotent.
5. **"Standard" = `defaultCount ≥ 1`.** This is what auto-separates the two shapes:
   Vote Counter (count 1) is synced onto every upcoming meeting; an occasional
   Jokemaster (count 0) is never synced and is added per-meeting only.
6. **Scope of "upcoming" = `scheduledAt > now()`** (UTC comparison; no
   club-timezone day-boundary logic). Sync never rewrites past meetings.
7. **No blocking confirms.** After adding a role, a non-blocking toast with an
   **"Update upcoming meetings"** action; a persistent sync button on the roles
   page; sync reports a specific result toast. No pre-confirm gate.

The **speaker/paired-evaluator pair** is identified with the existing
`pickSpeakerAndEvaluatorRoles` heuristic (already used by `slots-logic.ts`). The
same exclusion is applied in three places — generic add, generic remove, and sync
— from both the UI *and* the server guards, so the "a speaker always has an
evaluator" invariant can't be broken from any direction.

## Design

### 1. Data layer (`src/server/slots-logic.ts`)

Plain, integration-testable functions beside the existing `applyAddSpeakerSlot`:

**`applyAddRoleSlot({ meetingId, roleDefinitionId, actorMemberId })`**
- Load the meeting → resolve `clubId`; validate the role belongs to the same club.
- **Reject** a role that is the club's speaker or paired-evaluator role (those go
  through the pair button) with a clear error.
- Next `slotIndex` for that `(meeting, role)` via the existing `nextIndex` helper
  (duplicate → index N+1 → "Timer 2").
- Insert one `open`, unassigned slot; log `meeting_edit`
  (`detail: { change: "role_added", roleDefinitionId }`).

**`applyRemoveRoleSlot({ slotId, actorMemberId })`**
- Load the slot with its role + meeting → `clubId`, `isSpeakerRole`, status,
  `assignedMemberId`.
- **Reject** if the slot is claimed/assigned, or if its role is the speaker or
  paired-evaluator role.
- Delete the slot; log `meeting_edit` (`detail: { change: "role_removed" }`).

**`applyTemplateSyncToUpcomingMeetings({ clubId, actorMemberId })`**
- Standard roles = the club's `roleDefinitions` with `defaultCount ≥ 1`, minus the
  speaker and paired-evaluator roles.
- Upcoming meetings = same club, `scheduledAt > now()`.
- For each meeting, for each standard role it has **zero** slots of, insert one
  `open` slot; log a per-meeting `meeting_edit` so each meeting's history shows the
  change.
- Return `{ meetingsChanged: number, rolesAdded: string[] }` for the toast.

### Race safety (the triage's constraint)

ADR-0005 / PR #137's conditional-update guards protect the **claim/reassign of an
existing slot** from concurrent writers. This feature only ever **inserts
brand-new `open`, unassigned slots** (add + sync) or **deletes an unclaimed slot**
(remove) — it never mutates an existing slot's assignment or status, so those
guards don't apply. The only concurrency question is two admins computing the same
`slotIndex` at the same instant; there is no unique index on
`(meeting, role, slotIndex)`, so the worst case is cosmetic numbering — **exactly**
the risk profile of the shipped "+ Add speaker" button. Remove targets a specific
slot id and is naturally idempotent (a second delete affects 0 rows).

### 2. Server functions

`createServerFn` wrappers, all admin-gated; db logic stays in `*-logic.ts`
(enforced by `server-modules.guard.test.ts`).

- **`addRoleSlot`** (`src/server/slots.ts`) — `{ meetingId, roleDefinitionId,
  actorMemberId }`; resolves the meeting's `clubId` for the guard; calls
  `applyAddRoleSlot`.
- **`removeRoleSlot`** (`src/server/slots.ts`) — `{ slotId, actorMemberId }`;
  resolves the slot's `clubId` for the guard; calls `applyRemoveRoleSlot`.
- **`syncTemplateToUpcomingMeetings`** (`src/server/role-definitions.ts`, beside
  `createClubRole`) — `{ clubId, actorMemberId }`; admin-gates; calls
  `applyTemplateSyncToUpcomingMeetings`.

### 3. Per-meeting UI (`src/routes/_authed/meetings.$id.tsx`)

- **"+ Add role"** button among the meeting actions (`canManage`). Opens a small
  dialog: a `<select>` of the club's roles **excluding speaker + paired evaluator**,
  labeled by category, note that a repeat adds another instance ("Timer 2").
  Confirm → `addRoleSlot` → `router.invalidate()` → toast.
- **Per-slot remove**: a trash control on each **unclaimed, non-paired** slot (admin
  only). Click → `removeRoleSlot` → invalidate → toast. Speaker/evaluator slots
  show no trash; they keep the existing pair buttons.

New slots render as ordinary `open` slots in their category section; all existing
claim/assign/reassign controls work unchanged.

### 4. Roles-page UI (`src/routes/_authed/admin/roles.tsx`)

- **Persistent "Update upcoming meetings to match" button** at the top of the page.
  Click → `syncTemplateToUpcomingMeetings` (spinner while running) → result toast:
  - added something → `"Added Vote Counter to 8 upcoming meetings."` (name all
    roles when several were missing);
  - nothing missing → `"Upcoming meetings already match the standard set."`.
- **Nudge after adding a role**: on `createClubRole` success in `AddRoleForm`, a
  **non-blocking toast with an "Update upcoming meetings" action** that runs the
  same sync. Non-blocking so setting up a fresh template (six roles in a row) never
  becomes six confirm dialogs.

## Testing

Integration tests (mock `#/db` → `testDb`, `TEST_DATABASE_URL` set so DB suites run):

- **`applyAddRoleSlot`** — adds an `open` slot; a second call → `slotIndex` 1
  ("Timer 2"); rejects a role from a different club; **rejects the speaker and
  paired-evaluator roles**; writes the activity row.
- **`applyRemoveRoleSlot`** — deletes an unclaimed non-paired slot; **rejects a
  claimed slot**; **rejects a speaker/paired-evaluator slot**; second delete is a
  0-row no-op.
- **`applyTemplateSyncToUpcomingMeetings`** — adds each `defaultCount ≥ 1`
  non-paired standard role a meeting lacks; **skips roles already present** (re-run
  adds 0); **skips `defaultCount = 0` roles**; **never adds speakers/paired
  evaluators**; **past meetings untouched**; returns correct
  `{ meetingsChanged, rolesAdded }`.
- **`server-modules.guard.test.ts`** — stays green (db logic in `*-logic.ts`).

UI logic is thin wrappers over tested server fns; no separate UI unit tests.

## Out of scope

- Bulk *remove* / "un-sync" (per-meeting remove is the recovery path).
- Count-based top-up (sync is presence-only, by design).
- Adding roles via the public self-serve TMOD meeting page (admin/VPE only).
- Choosing a meeting sub-range for sync (sync = all upcoming meetings).
