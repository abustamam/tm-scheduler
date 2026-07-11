# Squishy Table Topics — design

**Date:** 2026-07-10
**Status:** Approved (brainstorm + grill), ready for implementation plan

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

**Exact-end property.** When the remainder falls within `[MIN, MAX]` (the normal
case), Table Topics absorbs the *exact* remainder, so `projected == target` exactly —
a 60-min meeting from 6:45 ends at **7:45 on the nose**, never 7:44. All beats and
`lengthMinutes` are integers, so there is no rounding anywhere. The only time the
projected end differs from the target is when the remainder is clamped, i.e. when
hitting the target is *physically impossible* (Table Topics has hit its floor/ceiling
and can't stretch/shrink further). In that case the agenda surfaces an **honest
warning** with the projected end time and a signed delta. Nothing is silently faked —
the displayed timeline always reflects reality.

### Decisions (locked during brainstorm + grill)

1. **Clamp to min/max, warn.** Table Topics has a floor and ceiling. Out-of-range
   remainders clamp, and a visible over/under warning appears (see the deadband below).
2. **Hardcoded constants.** `TABLE_TOPICS_MIN` / `TABLE_TOPICS_MAX` /
   `FLEX_TOLERANCE_MINUTES` live next to `RUN_OF_SHOW`. Per-club configuration stays
   deferred (consistent with the already deferred per-club-templates issue). No schema
   change, no migration.
3. **Derived, not stored.** Computed purely at render; no new columns.
4. **No Table Topics → no flex, still warn if off.** If the active template has no
   flex beat (or it yields no row), the timeline uses fixed durations and still warns
   when the projected end misses the target. **Note:** unreachable in v1 — `RUN_OF_SHOW`
   is hardcoded and always contains the Table Topics beat, and a plain-role beat always
   emits a row. The branch is kept for correctness/future custom templates, not because
   any v1 UI path reaches it.
5. **Flex basis = the row's existing `minutes` (speaker `maxMinutes`).** Each speaker
   is budgeted at its ceiling (`s.maxMinutes ?? DEFAULT_SPEAKER_MINUTES`), so the plan
   is conservative — Table Topics gets the leftover after reserving worst-case speech
   time. The over/under warning covers cases where the conservative plan doesn't fit.
6. **Directional warning severity.** `over` (runs long) carries alarm styling; `under`
   (ends early) is a neutral/info tone. Both show the projected end.
7. **±2-min deadband on the *banner only*.** `|delta| ≤ FLEX_TOLERANCE_MINUTES` reads
   as on-time and shows no banner. The deadband never affects the computed Table Topics
   duration — that is always the exact remainder, so the timeline stays internally
   consistent and the achievable end time stays exact (decision above). A residual
   delta only ever exists in the clamped case, where the miss is unavoidable anyway.
8. **Exact end ⇒ non-round Table Topics number.** The segment prints whatever the
   remainder is (e.g. "Table Topics · 13 min"), not a tidy 10/15. Accepted: an exact
   end time and a round segment number are mutually exclusive; we chose the exact end.

### Constant values

- `TABLE_TOPICS_MIN = 5`
- `TABLE_TOPICS_MAX = 25`
- `FLEX_TOLERANCE_MINUTES = 2`

(The current fixed value is `10`, which stays as the context-free fallback used when a
caller passes no target.)

## Code changes

Core logic in `src/lib/agenda-runsheet.ts`; wired into two call sites (print route +
meeting detail view).

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
type FlexStatus = "exact" | "over" | "under";

type FlexResult = {
  rows: AgendaRow[];        // flex row's `minutes` replaced with the clamped value
  projectedMinutes: number; // actual total after clamping
  status: FlexStatus;       // banner status, AFTER the deadband (see below)
  deltaMinutes: number;     // signed true delta: +5 = runs 5 long, −5 = ends 5 early
};

applyFlex(
  rows: AgendaRow[],
  flexRowIndex: number | null,
  targetMinutes: number,
): FlexResult;
```

Logic:
- If `flexRowIndex === null`: no flex. `projectedMinutes = sum(rows)`.
- Otherwise: `fixed = sum(rows) − rows[flexRowIndex].minutes`;
  `flex = clamp(targetMinutes − fixed, MIN, MAX)`; replace the flex row's minutes;
  `projectedMinutes = fixed + flex`.
- `deltaMinutes = projectedMinutes − targetMinutes` (the *true* signed delta, reported
  as-is regardless of the deadband).
- `status` applies the deadband: `"exact"` when `|deltaMinutes| ≤ FLEX_TOLERANCE_MINUTES`,
  else `"over"` when `deltaMinutes > 0` (runs long), `"under"` when `deltaMinutes < 0`
  (ends early). The deadband gates the *banner* (`status`), never the computed flex
  duration.

Because the flex row absorbs the exact remainder, `deltaMinutes` is nonzero *only* in
the clamped case, so the deadband only ever silences an unavoidable tiny miss.

### 4. Wire the target through — TWO surfaces

Both call sites run the same `expandRunSheet → applyFlex` pipeline so they agree.

**(a) Print / run-of-show route** (`club.$clubId_.meeting.$meetingId.print.tsx`):

```
const { rows: runRows, flexRowIndex } = expandRunSheet(slots);
const flex = applyFlex(runRows, flexRowIndex, meeting.lengthMinutes);
const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);
// render warning when flex.status !== "exact"
```

**(b) Meeting detail view** (`club.$clubId.meeting.$meetingId.tsx`): the loader
already returns the slot shape `expandRunSheet` needs (`loadMeetingDetail` in
`src/server/meetings.ts` — `minMinutes`/`maxMinutes`/`isSpeakerRole`/`evaluatesSlotId`),
so this is a cheap addition — no new query. Run `applyFlex` and render a compact
projected-end/warning line near the existing time range (`formatMeetingTimeRange`),
only when `flex.status !== "exact"`.

### 5. The warning UI

The detail view keeps showing the **target** range (`formatMeetingTimeRange`,
`start + lengthMinutes`) as the meeting's advertised time. The squishy signal is a
*separate* line that appears only when `status !== "exact"`, showing the **projected**
end (start + `projectedMinutes`, via the existing clock helper) and the signed
`deltaMinutes`. Directional severity:

- **over** (alarm styling): *"⚠ Projected end 7:50 — runs 5 min long. Trim a speech or
  shorten the agenda."*
- **under** (neutral/info): *"Projected end 7:40 — ends ~5 min early (Table Topics at
  its 25-min max)."*

Exact wording/styling finalized during implementation; the print route shows the same
signal in a print-appropriate spot.

## Surfaces

- **In scope:** the run-of-show / print route
  (`club.$clubId_.meeting.$meetingId.print.tsx`) **and** the meeting detail view
  (`club.$clubId.meeting.$meetingId.tsx`) — so the warning appears where the organizer
  plans, not only on the printed artifact.
- **Out of scope (v1):** the present deck (`agenda-slides.ts`) builds slides via its
  own role-mirroring path and computes no running clock; its Table Topics slide shows a
  per-speaker string (`"1–2 minutes per speaker"`), not a segment total, so it does not
  contradict the squishy total. Revisit only if we later want per-segment durations on
  slides.

## Testing

Pure-function unit tests in `agenda-runsheet.test.ts` (co-located with the logic):

1. **Exact fill** — remainder within bounds ⇒ Table Topics = remainder,
   `status: "exact"`, `deltaMinutes: 0`, and `projectedMinutes === target` exactly.
2. **Clamp high** — too much slack (e.g. 1 speaker, 90-min target) ⇒ Table Topics =
   `MAX`, `status: "under"`, negative delta.
3. **Clamp low / negative** — too little slack (e.g. 3 speakers in 60 min) ⇒ Table
   Topics = `MIN`, `status: "over"`, positive delta.
4. **Deadband** — a clamp that forces `|delta| ≤ 2` ⇒ `status: "exact"` (no banner)
   even though `deltaMinutes` is nonzero; and `|delta| = 3` ⇒ the directional status.
5. **No flex beat** — `flexRowIndex === null` ⇒ fixed durations, status reflects the
   real over/under (past the deadband).
6. **Timeline integrity** — `buildTimeline` over flexed rows still produces correct
   running-clock start times, and the last row + its duration equals the projected end.

## Non-goals / deferred

- Per-club or per-meeting configurable bounds/tolerance (stays with the deferred
  per-club-templates work).
- Flexing a fallback beat when Table Topics is absent (the `flexRowIndex === null`
  branch exists but has no v1 UI path).
- Per-segment durations on the present-mode slide deck.
- Rounding logic — integer beats + integer `lengthMinutes` guarantee whole-minute
  remainders; the segment shows the exact (possibly non-round) remainder by design.
