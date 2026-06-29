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

## Roster cutover (post-PR #39)

The roster now reads from the **`members`** table (the no-auth roster). But
`role_slots.assigned_user_id` still keys to a Better-Auth **user**, so member
history (speeches / speech log / roles served) is bridged member→user by
`members.userId` (admin link) or an email match — see the `TODO(cutover)` in
`src/server/club.ts`.

- **To finish the cutover:** re-key `role_slots.assigned_user_id` →
  `assigned_member_id` (FK → `members`), then drop the user bridge and key
  history directly to the member. Members with no linked user currently show 0
  history until then.

## Needs a model (mocked today)

### 1. Pathways enrollment + progress  ← highest value
No table for a member's path, level (1–5), % complete, or current project.
- **Mocked by:** `mockPathway(seed)` in `src/data/club.ts` (deterministic per
  user id). Drives the roster Pathway column + level/%, the member-detail level
  stepper, and the dashboard ring / "next up".
- **To add:** a `pathways` / `member_pathways` table (path, level, project,
  progress) + a server query; replace every `mockPathway()` call.

### 2. Member status (on track / behind / DTM)
Derived from Pathways progress, which doesn't exist. Only "new member"
(joined < ~90 days) is real (`isNewMember` in `src/lib/members.ts`).
- **Mocked by:** `mockPathway().status`. Drives roster status pills + the
  segment filters (All / On track / Needs attention / New / DTM track).
- **To add:** compute from real Pathways progress + recent-speech recency.

### 3. Awards / completions
No awards table.
- **Mocked by:** `mockAwards(level, status)` in `src/data/club.ts` (member
  detail) and the roster "Level completions" stat.
- **To add:** an `awards` table (level completions, DTM, etc.).

### 4. Resources library
Static content, no table.
- **Mocked by:** `src/data/resources.ts` (the `/resources` view).
- **To add:** a `resources` table if the library should be club-editable;
  otherwise this can stay static.

### 5. Meeting RSVPs + duration
The agenda "theme" card shows real word-of-the-day / speaker-slot counts, but the
design's RSVP count and duration have no model.
- **Handled by:** showing real-derived facts instead (open/confirmed counts).
- **To add:** an RSVP/attendance table + meeting duration field if wanted.

### 6. Reminders / notifications sending
A `notifications` table exists but sending is out of scope.
- **Stubbed by:** the agenda "Remind unfilled" button (toast only).
- **To add:** wire the notification poller (#7) + a send path.
