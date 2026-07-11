# Squishy Table Topics — design

**Date:** 2026-07-10
**Status:** Approved (brainstorm), ready for implementation plan

## Problem

A meeting has a **start time** (`meetings.scheduledAt`) and a **target duration**
(`meetings.lengthMinutes`, default 90). Prepared speeches vary in length, so the sum
of the fixed agenda beats rarely equals the target. Today the run-of-show uses fixed
per-beat durations (`RUN_OF_SHOW` in `src/lib/agenda-runsheet.ts`), so the projected
end time drifts from the intended end time with no adjustment.

We want the **Table Topics** segment to be "squishy": expand or contract it so the
meeting as a whole lands on its target duration.

## Solution overview

Table Topics duration is **derived at render time, never stored** — matching the
existing pure-timeline pattern (`buildTimeline`, `expandRunSheet` are pure functions).

```
tableTopicsMinutes = clamp(target − sum(all other rows), MIN, MAX)
```

where `target = meeting.lengthMinutes`, and `MIN`/`MAX` are hardcoded constants.

When clamping forces the projected total off the target, the agenda surfaces an
**honest warning** showing the projected end time and a signed delta. Nothing is
silently faked — the displayed timeline always reflects reality.

### Decisions (locked during brainstorm)

1. **Clamp to min/max, warn.** Table Topics has a floor and ceiling. Out-of-range
   remainders clamp, and a visible "runs long/short by X min" warning appears.
2. **Hardcoded constants.** `TABLE_TOPICS_MIN` / `TABLE_TOPICS_MAX` live next to
   `RUN_OF_SHOW`. Per-club configuration stays deferred (consistent with the already
   deferred per-club-templates issue). No schema change, no migration.
3. **Derived, not stored.** Computed purely at render; no new columns.
4. **No Table Topics → no flex, still warn if off.** If the active template has no
   flex beat (or it yields no row), the timeline uses fixed durations and still warns
   when the projected end misses the target.

### Proposed constant values

- `TABLE_TOPICS_MIN = 5`
- `TABLE_TOPICS_MAX = 20`

(The current fixed value is `10`, which stays as the context-free fallback.)

## Code changes

All in `src/lib/agenda-runsheet.ts` plus one call site.

### 1. Mark the flex beat

Add an optional `flex?: true` to the `Beat` type and set it on the **Table Topics
Master** beat. Its literal `minutes: 10` becomes the fallback used only when there is
no meeting-duration context (e.g. a caller that doesn't pass a target). Marking the
beat declaratively avoids matching on the role-name string.

### 2. `expandRunSheet` identifies the flex row

`expandRunSheet` returns the flex row's index alongside the rows so `applyFlex` stays
pure and needs no role-name matching. Shape (final naming at implementation time):

```ts
expandRunSheet(slots, template?) → { rows: AgendaRow[]; flexRowIndex: number | null }
```

`flexRowIndex` is `null` when the template has no flex beat or it yields no row.

Exactly one flex beat is expected. The Table Topics Master is a single plain role, so
it yields exactly one row. Defensive rule: if the flex beat somehow yields multiple
rows, flex the first and treat the rest as fixed. An **unassigned** Table Topics
Master (open / label-only row) still flexes — the segment occupies meeting time
regardless of who runs it.

### 3. New pure `applyFlex`

```ts
type FlexResult = {
  rows: AgendaRow[];        // flex row's `minutes` replaced with the clamped value
  projectedMinutes: number; // actual total after clamping
  status: "exact" | "over" | "under";
  deltaMinutes: number;     // signed: +5 = runs 5 min long, −5 = ends 5 min early
};

applyFlex(
  rows: AgendaRow[],
  flexRowIndex: number | null,
  targetMinutes: number,
): FlexResult;
```

Logic:
- If `flexRowIndex === null`: no flex. `projectedMinutes = sum(rows)`;
  `deltaMinutes = projectedMinutes − targetMinutes`; `status` derived from the sign
  (`exact` when 0).
- Otherwise: `fixed = sum(rows) − rows[flexRowIndex].minutes`;
  `flex = clamp(targetMinutes − fixed, MIN, MAX)`; replace the flex row's minutes;
  `projectedMinutes = fixed + flex`; `status`/`deltaMinutes` from
  `projectedMinutes − targetMinutes`.
- `status`: `"over"` when projected > target (meeting runs long), `"under"` when
  projected < target (ends early), `"exact"` when equal.

### 4. Wire the target through the print/run-of-show route

`src/routes/club.$clubId_.meeting.$meetingId.print.tsx`:

```
const { rows: runRows, flexRowIndex } = expandRunSheet(slots);
const flex = applyFlex(runRows, flexRowIndex, meeting.lengthMinutes);
const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);
// render warning when flex.status !== "exact"
```

### 5. The warning UI

When `status !== "exact"`, render a banner/line near the agenda header showing the
**projected** end time (start + `projectedMinutes`, via the existing clock helper) and
the signed delta, e.g.:

- over: *"Projected end 7:50 — runs 5 min long. Trim a speech or shorten the agenda."*
- under: *"Projected end 7:40 — ends 5 min early. Table Topics is at its 20-min max."*

Exact wording finalized during implementation.

## Surfaces

- **In scope:** the run-of-show / print route
  (`club.$clubId_.meeting.$meetingId.print.tsx`) — the only current consumer of
  `expandRunSheet` + `buildTimeline`.
- **Out of scope (v1):** the present deck (`agenda-slides.ts`) builds slides via its
  own role-mirroring path and computes no running clock. Revisit only if we later want
  per-segment durations on slides.

## Testing

Pure-function unit tests in `agenda-runsheet.test.ts` (co-located with the logic):

1. **Exact fill** — remainder within bounds ⇒ Table Topics = remainder,
   `status: "exact"`, `deltaMinutes: 0`.
2. **Clamp high** — too much slack (e.g. 1 speaker, 90-min target) ⇒ Table Topics =
   `MAX`, `status: "under"`, negative delta.
3. **Clamp low / negative** — too little slack (e.g. 3 speakers in 60 min) ⇒ Table
   Topics = `MIN`, `status: "over"`, positive delta.
4. **No flex beat** — `flexRowIndex === null` ⇒ fixed durations, warning reflects the
   real over/under.
5. **Timeline integrity** — `buildTimeline` over flexed rows still produces correct
   running-clock start times, and the last row + its duration equals the projected end.

## Non-goals / deferred

- Per-club or per-meeting configurable bounds (stays with the deferred
  per-club-templates work).
- Flexing a fallback beat when Table Topics is absent.
- Per-segment durations on the present-mode slide deck.
- Rounding logic — integer beats + integer `lengthMinutes` guarantee whole-minute
  remainders.
