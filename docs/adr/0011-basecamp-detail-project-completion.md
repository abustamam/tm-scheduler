# ADR-0011: Base Camp /detail — authoritative per-project completion + speeches

Status: Accepted

## Context

The Pathways progression model (spec 2026-07-06, ADR-0009) was built on two
assumptions: that Base Camp exposes only per-*level* counts (so project identity
"can never come from Base Camp"), and that speech-level data isn't exposed. A
per-member `/detail` endpoint disproves both — it returns per-project `complete`
flags with names, plus a speeches map (title + date). See #120.

## Decision

Use `/detail` as the authoritative source of named per-project completion and
speech history, **augmenting** (not replacing) the count-based mirror.

- A read-only mirror (`bcm_project_progress`) records per-project `complete` +
  speech title/date, re-derived every sync (replace-per-enrollment;
  last-known-good for members absent from a sync).
- The hand-seeded catalog **stays** the source of the elective *pool* — Base Camp
  never enumerates a member's *unchosen* electives (only placeholders), so the
  pool cannot be derived from `/detail`. `/detail` stamps `bcm_block_id` onto
  matched catalog rows and derives required (`imported`) projects we didn't seed.
- Our person-owned `speeches` table (ADR-0009) is untouched — no Base Camp data
  is written into it; the two sources coexist without merge/dedup.

## Consequences

- "Your wins" / "up next" / speech history can be sourced authoritatively from
  Base Camp instead of inferred from a member's own logged speeches; the
  inference path remains the fallback when an enrollment has no detail rows.
- Reverses the two assumptions in the 2026-07-06 progression-model spec (a
  superseding note is appended there).
- The extension does a bounded `members × paths` fan-out of `/detail` calls,
  graceful per-call, after its summary walk.
