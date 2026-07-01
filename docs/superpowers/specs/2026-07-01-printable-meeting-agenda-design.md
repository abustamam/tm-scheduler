# Printable Meeting Agenda — Design

- **Date:** 2026-07-01
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Branch:** `feat/printable-agenda`

## Goal

Generate a printable club meeting agenda from real meeting data, rendered in the
on-brand **timing** layout (the two-page detailed timing sheet) authored in Claude
Design and now committed at `templates/meeting-agenda/MeetingAgenda.dc.html`.

The design system template defines four layouts (`timing`, `spacious`, `editorial`,
`grid`) via a `layout` prop. **v1 ships `timing` only**; the other three are stubbed
behind the same prop and added incrementally later.

## Context

- The `.dc.html` template is a Claude Design canvas artifact (`<x-dc>` / `<sc-if>` /
  `<x-import>`), consumed by the design-canvas runtime, **not** by this TanStack app.
  Its content is hardcoded (one sample meeting); its only real input is the `layout`
  enum. We therefore **reproduce the timing layout as a React component** driven by
  real data — we do not run the `.dc.html` in the app.
- The data model already fits well:
  - `meetings` (`scheduledAt`, `location`, `theme`, `wordOfTheDay`, `status`, `notes`)
  - `roleDefinitions` (club role template: `name`, `category`, `sortOrder`,
    `isSpeakerRole`, `description`, `defaultCount`)
  - `roleSlots` (the live agenda rows: `roleDefinitionId`, `slotIndex`,
    `assignedMemberId`, `status`, `evaluatesSlotId`)
  - `speakerDetails` (1:1 with a speaker slot: `speechTitle`, `projectLevel`,
    `minMinutes`, `maxMinutes`)
  - `clubs` (`name`, `timezone`)
- Existing views already load meeting + slots: `getMeeting` / `getNextMeeting` in
  `src/server/meetings.ts` (via `loadMeetingDetail`), and `src/lib/agenda.ts` already
  provides `buildRoleCounts`, `slotLabel`, and `resolveEvaluatorLinks`.

## Scope

**v1 (this spec):**
- `timing` layout only, rendered from real data.
- Browser print → PDF (the template's `@media print` rules handle pagination).
- Running clock derived from durations; **no** per-meeting time-editing UI.
- Colored green/yellow/red marks for **speaker rows only** (the only rows with
  `min`/`max` in the schema).

**Explicitly deferred (follow-up tickets):**
- Server-generated PDF (headless render + download).
- `spacious`, `editorial`, `grid` layouts.
- Per-role `min`/`max` so evaluators / table-topics get colored marks.
- Club logo upload (the mockup's `image-slot`).
- Per-slot duration overrides + an agenda editor.

## Data model change

Add one column:

- `role_definitions.default_minutes` — `integer`, nullable. The club-template default
  duration for each role.
  - A **backfill migration** seeds Toastmasters-standard defaults for existing roles
    (by role name / category).
  - The role-creation path (club setup) sets it for new clubs.
  - `null` → the row contributes **0** to the running clock (realistic: e.g.
    Call-to-Order and Opening Remarks can both read `6:45`).

## Timeline computation — `src/lib/agenda-timing.ts`

A **pure** function (no DB, no React) — the deep module every layout reuses. Safe to
import client-side (no `#/db`), consistent with the repo's server-module guard.

**Input:**
- meeting `scheduledAt` (start), club `timezone`
- slots ordered by `roleDefinition.sortOrder` → `slotIndex`, each carrying: role name,
  category, `isSpeakerRole`, `default_minutes`, assignee name, role `description`,
  speaker details (`speechTitle`, `projectLevel`, `minMinutes`, `maxMinutes`), and the
  evaluator→speaker link.

**Output:** `TimelineRow[]`, each:
- `time` — running-clock string (e.g. `"6:45"`), formatted in the club timezone via
  `Intl` (DST-safe). Row _n_'s time = start + sum of prior rows' durations.
  - Row duration = `isSpeakerRole ? (maxMinutes ?? default_minutes ?? 0) : (default_minutes ?? 0)`.
- `label` — role label via existing `buildRoleCounts` / `slotLabel` ("Speaker 1"),
  plus "· {Name}" for assigned speaker/evaluator rows.
- `detail` — role `description`; for speakers, speech title + project level; for
  evaluators, "Evaluates {speaker}" (via `resolveEvaluatorLinks`).
- `marks` — `{ green, yellow, red }` from `min` / `(min + max) / 2` / `max`, or `null`.
  - Requires **both** `minMinutes` and `maxMinutes`; if only one is set → `null`.
  - Only speaker rows have `min`/`max` in v1, so only they get marks.

## Rendering

**Component — `src/components/agenda/meeting-agenda-print.tsx`**
- Presentational, props `{ layout, header, rows }`.
- Reproduces the template's `timing` layout with **inline styles** using the mockup's
  brand hex (lagoon `#328f97`, sea-ink `#173a40`, mark colors green/amber/red) and its
  `@media print` rules (US-Letter portrait, `break-after: page`, drop-shadows hidden).
  Inline styles (not Tailwind utilities) because it is a fixed print artifact with
  specific brand colors.
- `layout` prop matches the design-system `MeetingAgenda` contract: `timing` is fully
  built; `spacious` / `editorial` / `grid` render a small "layout coming soon" stub so
  the prop shape is stable and the other three drop in as pure render branches.

**Print route — `src/routes/club.$clubId.meeting.$meetingId.print.tsx`**
- **Public**, mirroring the meeting view's access.
- Loader: calls `getMeeting`, runs `agenda-timing.ts`, passes `header` + `rows` to the
  component.
- Reads `?layout=timing` (default `timing`) so one URL serves all four layouts over time.
- Chrome-free (no app nav) — just the agenda plus a small "Print" button that calls
  `window.print()` and hides itself under `@media print`.

**Entry point**
- A "Print agenda" button (lucide `Printer`) on the meeting view
  (`src/routes/club.$clubId.meeting.$meetingId.tsx`), linking to the print route in a
  new tab.

**Header data mapping**
- Club **name**, meeting **date**, **theme**, **word of the day**, **location** — all
  map from real fields.
- **Meeting number** ("Meeting 54") — no schema field; v1 derives a 1-based ordinal
  from the club's meeting order (a cheap count query over the club's meetings up to and
  including this one, by `scheduledAt`). The date is always shown alongside it.
- **Club logo** — no `clubs.logo` field; v1 omits it (or shows a club-initials
  placeholder). Logo upload is a deferred ticket.

## Edge cases

- **Open / unassigned slot** → row shows the role + "— open —", no name. Speaker slot
  without `speakerDetails` → role only, no title/marks.
- **`null` duration** → contributes 0; adjacent rows can share a clock time (expected).
- **Meeting not found / cancelled** → reuse the existing `MeetingNotFound` pattern.
  No slots yet → header + empty run-of-show.
- **Pagination** → the mockup is a fixed two-page design, but real agendas vary in
  length, so v1 lets content flow across pages via the template's `@media print`
  `break-after` rules. Exact two-page fidelity is best-effort, not guaranteed.

## Data-layer

- Extend `loadMeetingDetail`'s projection (in `src/server/meetings.ts`) to include what
  the timeline needs if not already present: club **name**, speaker **title / level /
  min / max**, and role **`default_minutes`**.
- `agenda-timing.ts` stays pure (no `#/db`), so the print route loader (server) calls
  `getMeeting` (server fn) + `agenda-timing.ts`, and the component imports only the pure
  lib — no `pg` in the client bundle.

## Testing

- **`src/lib/agenda-timing.test.ts` (Vitest)** — the main surface (pure function):
  - running-clock accumulation across mixed durations
  - speaker duration = `maxMinutes` (fallbacks when null)
  - `null`-duration rows sharing a clock time
  - "Speaker 1 / 2" numbering for repeated roles
  - evaluator "Evaluates {speaker}" resolution
  - marks: `min` / `(min+max)/2` / `max`; partial (only min or only max) → `null`
  - timezone formatting (a non-UTC club timezone)
- **Component** — presentational; at most a smoke render that the `timing` layout emits
  rows. No new integration test (`getMeeting` is already covered).

## Open questions

None outstanding — resolved during brainstorming:
- Clock model → durations, auto-computed.
- Duration scope → role-template defaults only (no editor in v1).
- Output → print page + browser PDF now; server-generated PDF is a follow-up ticket.
- Marks → speaker-only in v1.
