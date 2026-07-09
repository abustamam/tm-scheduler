# Add a role to existing meetings (#143)

## Problem

Meeting slots are generated **only at meeting creation**: `applyCreateMeeting`
(`src/server/meetings-logic.ts:34–57`) reads the club's `roleDefinitions` and
inserts `generateSlotRows` once. Nothing afterward can attach a role's slot to a
meeting that already exists.

Consequences:

- The meeting view (`src/routes/_authed/meetings.$id.tsx`) has **"+ Add speaker" /
  "− Remove speaker"**, but that is hardwired to the speaker+evaluator pair
  (`applyAddSpeakerSlot`). There is no way to add an arbitrary role (Timer,
  Wordmaster, a second functionary, …) to an existing meeting.
- Adding a new role in the admin template (`createClubRole`) only affects
  **future** meetings — existing meetings never receive it (documented in
  `roles.tsx` and `applyRoleDefinitionCreate`).

Issue #143 is, generally: **attach an arbitrary role slot to an existing meeting**
— of which the existing "+ Add speaker" button is a special case.

## Decisions (from brainstorming)

1. **Ship both surfaces**, with the per-meeting add as the shared primitive and
   the bulk backfill reusing it.
2. **Per-meeting: add any role, including duplicates. Add-only.** Removing a
   non-speaker slot is out of scope for #143 (speaker remove stays as-is).
3. **Bulk "apply to upcoming": prompt at role creation + an explicit per-role
   button.** Scope = all future meetings (`scheduledAt > now`). Idempotent:
   skip any meeting that already has that role, so re-running is safe.
4. **Admin/VPE only.** Gated behind `canManage` in the signed-in meeting view;
   server fns use `requireClubRole(user.id, clubId, ["admin"])`. The public
   self-serve TMOD meeting page keeps only the existing speaker buttons.

## Design

### 1. Data layer — the primitive (`src/server/slots-logic.ts`)

Two new plain, integration-testable functions, siblings to the existing
`applyAddSpeakerSlot`:

**`applyAddRoleSlot({ meetingId, roleDefinitionId, actorMemberId })`**

- Load the meeting → resolve `clubId`.
- Validate the `roleDefinitionId` belongs to the **same club** as the meeting
  (guards against attaching another club's role).
- Compute the next `slotIndex` for that `(meeting, roleDefinition)` pair using the
  existing `nextIndex` helper — a duplicate lands at index N+1 (renders as
  "Timer 2").
- Insert **one** `open`, unassigned slot; log a `meeting_edit` activity
  (`detail: { change: "role_added", roleDefinitionId }`).

**`applyAddRoleToUpcomingMeetings({ clubId, roleDefinitionId, actorMemberId })`**

- Find club meetings with `scheduledAt > now()`.
- **Skip** any meeting that already has ≥1 slot of that role (idempotent).
- For each remaining meeting, insert `max(defaultCount, 1)` slots — making those
  meetings look as if the role had been in the template at creation.
- Return `{ added }` (number of meetings touched) for the toast.

### Race safety (the triage's constraint)

ADR-0005 / PR #137's conditional-update guards protect the **claim/reassign of an
existing slot** from concurrent writers. This feature only ever **inserts
brand-new `open`, unassigned slots** and never touches an existing slot's
assignment or status, so those guards do not apply here.

The only concurrency question is two admins adding the same role at the same
instant computing the same `slotIndex`. There is no unique index on
`(meeting, roleDefinition, slotIndex)`, so the worst case is cosmetic numbering —
**exactly** the risk profile of the already-shipped "+ Add speaker" button
(`applyAddSpeakerSlot`, same read-then-insert pattern). This design matches that;
it does not regress it.

### 2. Server functions

Two new `createServerFn` wrappers, both admin-gated
(`requireClubRole(user.id, clubId, ["admin"])`). Wrappers export only
`createServerFn`s; all db logic stays in `*-logic.ts` (enforced by
`server-modules.guard.test.ts`).

- **`addRoleSlot`** in `src/server/slots.ts` — validates
  `{ meetingId, roleDefinitionId, actorMemberId }`, resolves the meeting's
  `clubId` for the guard, calls `applyAddRoleSlot`.
- **`addRoleToUpcomingMeetings`** in `src/server/role-definitions.ts` (a
  template-management action, beside `createClubRole`) — validates
  `{ clubId, roleDefinitionId }`, admin-gates, calls
  `applyAddRoleToUpcomingMeetings`.

### 3. Per-meeting UI (`src/routes/_authed/meetings.$id.tsx`)

An **"+ Add role"** button among the meeting actions (shown when `canManage`),
opening a small dialog:

- A `<select>` of the club's roles (from `listClubRoles`), labeled by category.
- A note that picking a role already present adds another instance
  (e.g. "Timer 2").
- Confirm → `addRoleSlot` → `router.invalidate()` → toast.

The new slot renders in its category section as a normal `open` slot; all existing
claim/assign/reassign controls work unchanged. No new slot-rendering logic.

### 4. Bulk UI (`src/routes/_authed/admin/roles.tsx`)

Both entry points call `addRoleToUpcomingMeetings`:

- **Per-role button** — "Add to upcoming meetings" on each `RoleCard`. Confirms,
  then toasts `Added to N meetings` (or "All upcoming meetings already have this
  role").
- **Prompt at creation** — after `createClubRole` succeeds in `AddRoleForm`, if
  upcoming meetings exist, show a confirm ("Also add *{name}* to your upcoming
  meetings?"). Yes → the same bulk call chained onto the create flow.

## Testing

Integration tests follow the established pattern (mock `#/db` → `testDb`, with
`TEST_DATABASE_URL` set so DB suites actually run):

- **`applyAddRoleSlot`** — adds an `open` slot; a second call yields `slotIndex` 1
  (duplicate → "Timer 2"); rejects a `roleDefinitionId` from a different club;
  writes the `meeting_edit` activity row.
- **`applyAddRoleToUpcomingMeetings`** — future meetings only (past untouched);
  skips meetings that already have the role (re-run adds 0); inserts
  `max(defaultCount, 1)` per meeting; returns the correct `added` count.
- **`server-modules.guard.test.ts`** — stays green (new db logic lives in
  `*-logic.ts`).

No UI unit tests beyond the logic coverage; the dialog and prompt are thin
wrappers over the tested server fns.

## Out of scope

- Removing arbitrary (non-speaker) slots from a meeting.
- Adding roles via the public self-serve TMOD meeting page.
- Choosing a meeting sub-range for bulk apply (bulk = all future meetings).
