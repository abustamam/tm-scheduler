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
  `assigned_user_id` directly is a bug.
- Releasing a slot clears `speaker_details` and resets it to `open`.
