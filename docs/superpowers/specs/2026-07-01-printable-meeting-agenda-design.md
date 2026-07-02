# Printable Meeting Agenda — Design

- **Date:** 2026-07-01
- **Status:** Approved (brainstorming + grilling) → ready for implementation plan
- **Branch:** `feat/printable-agenda`

## Goal

Generate a printable club meeting agenda from real meeting data, rendered in the
on-brand **timing** layout (the two-page detailed timing sheet) authored in Claude
Design and committed at `templates/meeting-agenda/MeetingAgenda.dc.html`.

The design-system template defines four layouts (`timing`, `spacious`, `editorial`,
`grid`) via a `layout` prop. **v1 ships `timing` only**; the other three are stubbed
behind the same prop and added incrementally later.

## Key design decision — the run-of-show template

A meeting's `role_slots` are just the **claimable roles** (8 for this club: Toastmaster
of the Day, Table Topics Master, Speaker×3, Evaluator×3, General Evaluator, Timer,
Ah-Counter, Grammarian). They are **not** a run-of-show: ordering them by `sort_order`
gives a flat grouped list, and the real agenda has ceremonial/event beats that aren't
roles at all (Call to Order, votes, timer reports, awards, adjourn) plus officer roles
the app doesn't model (President, Sergeant-at-Arms).

So the agenda is built from a **hardcoded standard run-of-show template** (a TS constant)
that defines the *sequence* of beats and weaves the club's assigned `role_slots` into the
right positions. This is v1's central abstraction.

- **Single hardcoded template** in v1 (one standard Toastmasters flow). Per-club
  configurable templates are a **deferred issue** (they'll likely want a schema-backed,
  editable template).
- **No schema change and no migration for v1** — the template constant owns every beat's
  default duration; only **speaker** beats override duration with real data
  (`maxMinutes`). (This supersedes the earlier idea of adding
  `role_definitions.default_minutes`.)

### Beat kinds

Each beat in the template is one of:
- **`event`** — a ceremonial/functional beat not tied to a claimable role (Call to Order,
  votes, timer reports, awards, adjourn). Carries a static label, detail text, and a
  default duration. If its static label happens to match a *tracked, assigned* role, the
  beat also shows that assignee's name; otherwise it shows the label only (this is how
  President / Sergeant-at-Arms render — label, no name).
- **`role`** — bound to a club role **by name** (case-insensitive). Expands to one row per
  **actual slot** of that role in the meeting (open slots included, shown "— open —") —
  driven by real slots, not `default_count`. If the role isn't found (renamed/removed),
  the beat renders with a blank/"— open —" name rather than crashing.

### Standard template (v1) — beat list for review

Ordered beats (durations are tunable constants, approximating the mockup):

1. **Call to Order** — event · "Sergeant-at-Arms" · phones silent, exits noted
2. **Opening remarks** — event · "President" · welcomes guests
3. **Toastmaster opens meeting** — role `Toastmaster of the Day` · introduces theme & GE
4. **General Evaluator introduces team** — role `General Evaluator` · Grammarian shares WOD
5. **Speaker _n_** — role `Speaker` (expands per slot) · speech title + project level ·
   duration = `maxMinutes`; **colored marks** (green/yellow/red = min / midpoint / max)
6. **Timer's report · vote Best Speaker** — event
7. **Table Topics** — role `Table Topics Master` · impromptu topics using the WOD
8. **Timer's report · vote Best Table Topics** — event
9. **Evaluator _n_** — role `Evaluator` (expands per slot, ordered by the speaker each
   evaluates via `evaluatesSlotId`) · "Evaluates {speaker}"
10. **Timer's report · vote Best Evaluator** — event
11. **General Evaluator report** — role `General Evaluator` · Grammarian, Ah-Counter &
    Timer reports; overall feedback
12. **Awards** — event · "Toastmaster" · Best Table Topic, Evaluator & Speaker
13. **Club business · adjourn** — event · "President" · elections, guest comments

Notes:
- `General Evaluator` appears twice (beats 4 and 11) — same assignee, both fine.
- **Event beats always render** (the standard ceremony) regardless of assignees, so the
  sheet is deterministic even for a sparse meeting. Zero speaker slots → zero speaker
  rows, but the surrounding vote/report events still show.

### Roles legend

Functionaries (Timer, Ah-Counter, Grammarian) and **any assigned role the template never
gives a prominent row** appear in a **compact roles legend** in the header
(`Timer · {name} · Ah-Counter · {name} · Grammarian · {name} …`), so no assignee is ever
silently dropped. Run-of-show rows stay focused on sequence; the legend covers "who holds
which role."

## Context

- The `.dc.html` template is a Claude Design canvas artifact (`<x-dc>` / `<sc-if>` /
  `<x-import>`), consumed by the design-canvas runtime, **not** this app. Its content is
  hardcoded and its only real input is the `layout` enum, so we **reproduce the timing
  layout as a React component** from real data rather than running the `.dc.html`.
- Existing data + loaders:
  - `meetings` (`scheduledAt`, `location`, `theme`, `wordOfTheDay`, `status`, `notes`),
    `roleDefinitions` (`name`, `category`, `sortOrder`, `isSpeakerRole`, `description`),
    `roleSlots` (`assignedMemberId`, `slotIndex`, `evaluatesSlotId`), `speakerDetails`
    (`speechTitle`, `projectLevel`, `minMinutes`, `maxMinutes`), `clubs` (`name`,
    `timezone`).
  - `loadMeetingDetail` (in `src/server/meetings.ts`, behind `getMeeting`) already returns
    the meeting, slots ordered by `sortOrder`→`slotIndex` with role name/category/
    description/`isSpeakerRole`, assignee name, full speaker details, evaluator links, and
    timezone. It is missing only the club **name**.
  - `src/lib/agenda.ts` provides `buildRoleCounts`, `slotLabel`, `resolveEvaluatorLinks`.

## Scope

**v1 (this spec):** `timing` layout only; browser print → PDF; run-of-show driven by the
hardcoded template; speaker-only colored marks; roles legend for functionaries.

**Explicitly deferred (follow-up tickets):**
- Server-generated PDF (headless render + download).
- `spacious`, `editorial`, `grid` layouts.
- **Per-club configurable run-of-show templates** (likely schema-backed + editable).
- Per-role `min`/`max` so evaluators / table-topics get colored marks.
- Club logo upload (the mockup's `image-slot`).
- Officer roles (President, Sergeant-at-Arms) as tracked, assignable roles.

## Modules

### `src/lib/agenda-runsheet.ts` — the template (pure data + expansion)

- The `RUN_OF_SHOW` constant: an ordered array of beat descriptors
  (`{ kind, label, detail, defaultMinutes, roleName?, showMarks? }`).
- `expandRunSheet(template, slots)` → an ordered list of concrete beats with their bound
  slot(s) resolved: event beats pass through; role beats expand over matching actual
  slots (open included); evaluators ordered by `evaluatesSlotId`. Pure, no DB/React.

### `src/lib/agenda-timing.ts` — the timeline (pure)

Consumes the expanded beats + meeting start + timezone and produces `TimelineRow[]`:
- `time` — running clock ("6:45"), formatted in club timezone via `Intl` (DST-safe);
  row _n_ = `scheduledAt` + sum of prior durations. Duration = speaker beat ?
  (`maxMinutes` ?? template default) : beat `defaultMinutes`.
- `label` — beat label via `buildRoleCounts`/`slotLabel` ("Speaker 1"), plus "· {Name}"
  for assigned role/ceremonial rows that resolve to a tracked assignee.
- `detail` — beat detail; speakers add title + project level; evaluators add
  "Evaluates {speaker}".
- `marks` — `{green, yellow, red}` from `min` / `(min+max)/2` / `max`, only when **both**
  are present (speakers in v1); else `null`.

Both libs are pure (no `#/db`), safe to import client-side — consistent with the repo's
server-module guard.

### `src/components/agenda/meeting-agenda-print.tsx` — presentation

- Props `{ layout, header, legend, rows }`. Reproduces the template's `timing` layout with
  **inline styles** using the mockup's brand hex (lagoon `#328f97`, sea-ink `#173a40`,
  mark colors) and its `@media print` rules (US-Letter portrait, `break-after: page`,
  drop shadows hidden). Inline styles because it is a fixed print artifact.
- `layout` prop matches the design-system `MeetingAgenda` contract: `timing` is built;
  `spacious`/`editorial`/`grid` render a small "layout coming soon" stub.

### `src/routes/club.$clubId.meeting.$meetingId.print.tsx` — the route

- **Public** (mirrors the meeting view). Loader calls `getMeeting`, runs
  `expandRunSheet` → `agenda-timing`, passes `header`/`legend`/`rows` to the component.
- Reads `?layout=timing` (default `timing`) so one URL serves all four layouts over time.
- Chrome-free (no app nav); a **manual "Print" button** calls `window.print()` and hides
  itself under `@media print` — **no auto-print** on load.

### Entry point

- A "Print agenda" button (lucide `Printer`) on the meeting view
  (`src/routes/club.$clubId.meeting.$meetingId.tsx`) opens the print route in a new tab.

## Header data mapping

- Club **name**, meeting **date**, **theme**, **word of the day**, **location** — real
  fields. (Add club `name` to `loadMeetingDetail`'s projection.)
- **Meeting number** — dropped (no schema home, not worth deriving). Header/footer show
  club name + date.
- **Club logo** — no `clubs.logo` field; v1 omits it (or a club-initials placeholder).
  Deferred.

## Edge cases

- **Open / unassigned slot** → row shows role + "— open —". Speaker slot without
  `speakerDetails` → role only, fallback duration, no title/marks.
- **Meeting not found / cancelled** → reuse the existing `MeetingNotFound` pattern.
  No slots → header + legend + event-only ceremony still render.
- **Pagination** → the mockup is a fixed two-page design, but real agendas vary in length,
  so v1 lets content flow across pages via the template's `@media print` `break-after`
  rules. Exact two-page fidelity is best-effort.
- **Timezone** → clock formatted in the club timezone (DST-safe).

## Testing

- **`src/lib/agenda-runsheet.test.ts`** — expansion: speaker/evaluator beats expand over
  actual slots (incl. open); evaluators ordered by `evaluatesSlotId`; event beats always
  present; a renamed/missing role degrades gracefully; unreferenced assigned roles surface
  for the legend.
- **`src/lib/agenda-timing.test.ts`** — running-clock accumulation; speaker duration =
  `maxMinutes` with fallback; marks (min/mid/max; partial → none); "Speaker 1/2"
  numbering; "Evaluates {speaker}"; non-UTC timezone formatting.
- **Component** — presentational; at most a smoke render that the `timing` layout emits
  rows + legend. No new integration test (`getMeeting` already covered; no schema change).

## Open questions

None outstanding — resolved during brainstorming + grilling:
- Agenda = **hardcoded run-of-show template** weaving in real slots (per-club deferred).
- **No schema change** — template owns durations; speakers use `maxMinutes`.
- Bind role beats **by name**, tolerate misses, expand by **actual** slot count.
- Functionaries + any unreferenced role → **roles legend**.
- Ceremonial beats → static label, name only when a tracked role backs it.
- Clock anchor = `scheduledAt`; public route; **manual** print (no auto-print).
- Marks → speaker-only in v1.
