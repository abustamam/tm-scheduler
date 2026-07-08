# GavelUp workspace — persistence action items

The club workspace views are wired to real data where a database model exists.
The items below have **no model yet** and are currently mocked or stubbed in the
UI. Each notes where the placeholder lives so it can be swapped for real data.

## Wired to real data (done)

- **Agenda & roles** (`/agenda`) — next meeting, slots, assignees, speaker
  details, evaluator→speaker links; claim/release are real writes
  (`getNextMeeting`, `claimSlot`, `releaseSlot`).
- **Roster** (`/`) — member list + "speeches given" (count of speaker slots),
  "active members" and "open roles" stats (`listClubMembers`,
  `listUpcomingMeetings`).
- **Member detail** (`/members/$id`) — identity, tenure, speech log, "roles
  served this year" (`getMemberProfile`).
- **My dashboard** (`/dashboard`) — greeting, speech log, upcoming roles
  (`listMyCommitments`, `listMySpeeches`).
- **Roster cutover** — `role_slots` keys to `assigned_member_id` (FK → members);
  the user bridge is gone. Member history (speeches / roles served) keys
  directly to the member, so members with no sign-in account still carry full
  history (PR #39 → cutover shipped).
- **Pathways enrollment + progress** — modeled and synced from Base Camp:
  `path_enrollments`, `path_level_progress`, `pathways_projects`,
  `bcm_project_progress` (+ the `pathways_paths` / `pathways_path_levels`
  catalog), populated by the browser extension via `POST /api/pathways/ingest`
  (ADR-0011). The roster Pathway column, member-detail level stepper, and
  `/pathways/detail` read this real data.

## Needs a model (todo)

### 1. Member status (on track / behind / DTM)
A *derived* status view is not built yet. Only "new member" (joined < ~90 days)
is real (`isNewMember` in `src/lib/members.ts`).
- **To add:** compute a status from the real Pathways tables above
  (`path_level_progress` / `bcm_project_progress`) + recent-speech recency, then
  drive the roster status pills + segment filters (All / On track / Needs
  attention / New / DTM track).

### 2. Awards / completions
No awards table. Pathways level/project completion is tracked in
`path_level_progress` / `bcm_project_progress`, but club-level award records
(DTM, Level completions rollups) have no home.
- **To add:** an `awards` table (level completions, DTM, etc.), or derive the
  roster "Level completions" stat from the Pathways progress tables.

### 3. Resources library
Static content, no table.
- **Mocked by:** `src/data/resources.ts` (the `/resources` view).
- **To add:** a `resources` table if the library should be club-editable;
  otherwise this can stay static.

### 4. Meeting RSVPs + duration
The agenda "theme" card shows real word-of-the-day / speaker-slot counts, but the
design's RSVP count and duration have no model.
- **Handled by:** showing real-derived facts instead (open/confirmed counts).
- **To add:** an RSVP/attendance table + meeting duration field if wanted.

### 5. Reminders / notifications sending
A `notifications` table exists but sending is not built yet.
- **Stubbed by:** the agenda "Remind unfilled" button (toast only).
- **To add:** wire the notification poller (#7) + a send path. The email gate is
  now cleared (`src/lib/email.ts`, Resend), so the build is unblocked — see
  `plans/020-reminders-build.md`.
