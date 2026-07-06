# ADR-0009: Speeches as first-class, Person-owned entities

Status: Accepted

## Context

A speech's details (title, Pathways path/project, min/max minutes) live in `speaker_details`,
1:1 with a single `role_slots` row (PK = `slot_id`, `ON DELETE CASCADE`). Speech data is
therefore bound to a scheduled slot, which causes three problems (see #79):

- **Reassign is destructive.** Moving a speaker slot to another member wipes the speech and
  resets to a TBA placeholder — ADR-0005's consequence "releasing a slot clears
  `speaker_details`" made this deliberate as a stopgap (the VPE assign-slot work).
- **No rescheduling.** A member can't move a prepared speech from one meeting to another; the
  details don't exist independently of the schedule.
- **No durable speech / continuity.** A speech isn't an object a member owns across meetings,
  so future Pathways progress has nothing to hang off.

## Decision

Model a **Speech** as a first-class entity **owned by a Person** (ADR-0008), independent of
the schedule. A speaker slot *references* a speech instead of embedding its details.

- New `speeches` table — pure person-level content: `{ id, person_id, title, introduction?,
  pathway_path, project_name, project_level, min_minutes, max_minutes }` + timestamps.
  - **Person-owned**, so a prepared speech is durable and portable across the person's clubs.
  - **No `clubId`** — a delivery's club comes from the slot → meeting it's attached to, not
    from the speech (pinning a club would forfeit cross-club portability).
  - **No stored `status`** — scheduling state (unscheduled / scheduled / delivered) is
    *derived* from slot linkage + meeting date, avoiding drift (consistent with ADR-0005).
- `role_slots` gains a nullable `speech_id`. Null = TBA (assigned member, speech attached
  later). `speaker_details` is dropped.

**Pointer lifecycle** (the reason the entity exists):

- **Reassign a slot to a different Person** — clear `speech_id` (unlink); the old speech is
  **not deleted**, it persists Person-owned and unscheduled. This revises ADR-0005's
  "releasing clears `speaker_details`": the link clears, the speech survives.
- **Reschedule** — move `speech_id` to the new slot; the old slot's clears. Speech untouched.
- **Invariant** — a speech is referenced by at most one active (non-cancelled) slot at a time.
- **History** — "speeches delivered" = past slots joined to `speech_id`; slots remain the
  history spine (ADR-0005 unchanged on that point).

**Ownership requires #64.** A speech's `person_id` comes from the assigned membership's
Person, so #79 sequences **after #64 Phase A** (the `people` table).

**Migration** — one speech per `speaker_details` row *with content*, owned by the assignee's
Person, with the slot's `speech_id` set; pure-TBA (empty) placeholders become null `speech_id`
(no blank speech row); rows whose slot has no assignee are skipped and logged. Then drop
`speaker_details`.

Pathways `pathway_path` / `project_name` / `project_level` stay **free text** for now; a spike
issue will explore modeling Pathways paths/projects as first-class entities the speech links to.

## Consequences

- Non-destructive reassign, rescheduling, and durable speech history all fall out of the
  Person-owned entity; ADR-0005's destructive-release consequence for speaker slots is retired.
- `speaker_details` is removed; any code reading it moves to the `speeches` join via
  `role_slots.speech_id`.
- Deriving scheduling state means the "unscheduled speeches" surface (a follow-up) is a query,
  not a status filter; an `archived` flag (also a follow-up) is the only non-derivable state.
- #79 is blocked on #64 Phase A landing first.
