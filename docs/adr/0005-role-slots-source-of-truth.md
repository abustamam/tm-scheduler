# ADR-0005: `role_slots` as the source of truth, history, and concurrency boundary

Status: Accepted

## Context

The core object is "a role to be filled at a meeting." We need: the live agenda, the record
of who did what (for rotation and VP Education reporting later), and protection against two
members claiming the same role at once — something the spreadsheet never guarded.

## Decision

Model one row per fillable role in **`role_slots`**, generated from the club's
`role_definitions` when a meeting is created. This one table serves three jobs:

1. **Live agenda** — `status` is `open` | `claimed` | `confirmed`; `assigned_user_id` holds
   the claimant.
2. **History** — "who has done what / who's overdue" is a query over slots of past meetings.
   No separate history table.
3. **Concurrency boundary** — claiming uses a conditional update
   (`UPDATE role_slots SET ... WHERE id = ? AND status = 'open'`) inside a transaction; if
   zero rows update, the caller lost the race and gets a clean error.

Evaluator slots reference the speaker slot they evaluate via the self-referential
`evaluates_slot_id`. Speaker-specific fields live in `speaker_details` (1:1).

## Consequences

- The Phase-3 VP Education dashboard (speaker queue, rotation, overdue members) needs no new
  tables — only queries over `role_slots`.
- Any future write path that assigns a slot MUST use the conditional-update guard; setting
  the assignee column directly is a bug. That column is `assigned_member_id` today —
  `assigned_user_id` above is the name as decided here, renamed by ADR-0008's roster cutover
  (#79); the rule is unchanged, only the column moved.
- The speaker/evaluator pair mutations (add, remove, and both reorders) serialize on the
  MEETING row instead — `lockMeetingForSlotEdit` in `slots-logic.ts` takes
  `SELECT … FOR UPDATE` before the reads that DECIDE numbering and pairing (v1.26.0.0). The
  per-slot conditional update above does not substitute for it: which slot is "the next index"
  or "the paired evaluator" is not a property of one row. The two boundaries do not serialize
  against each other — see TODOS.md for the remove-vs-claim window that leaves open.
- Releasing a slot clears `speaker_details` and resets it to `open`.
