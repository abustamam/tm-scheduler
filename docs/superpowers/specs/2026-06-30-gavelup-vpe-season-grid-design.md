# GavelUp — VPE Season Grid Design

- **Date:** 2026-06-30
- **Status:** Approved (brainstorm + visual companion + grilling complete); ready for implementation plan
- **Issue:** #38 (VPE overview grid + roster management), scoped down to the **season grid only**
- **Builds on:** `2026-06-29-gavelup-self-serve-mvp-design.md` §6; the `_authed` desktop workspace shell (PR #40); roster mgmt (#47) and activity log (#46), already shipped.

## North star

Give the VPE a **desktop, signed-in planning god-view** of the season: members × meetings at a
glance, gaps obvious. The real job this serves is **fast role assignment for future meetings —
as quick as the spreadsheet the VPE uses today.** v1 is **read-only** (a great _seeing_ surface),
but it is deliberately structured so that **inline click-to-assign drops in as the immediate
next step** — that is the planned follow-up, not a someday-maybe.

## Scope

**In:** the season grid view (both orientations + toggle), its read aggregation server fn, the
route + nav placement, color/visual treatment, and the four agreed visual touches.

**Out (separate issues / follow-ups):**
- **Inline assign/unassign in the grid** — the very next issue; this spec keeps the cell + data
  shape ready for it. Note: the **assignment/confirmation workflow** ("VPE assigns → member
  confirms" vs the current "member claims → VPE confirms") is an open product decision that gets
  settled **in that follow-up**, not here (see Cell semantics).
- **Role-template editing** (role definitions: counts, order, descriptions, curated abbreviations)
  — split into its own issue out of #38.
- **Bulk-creating future meetings** — stays in the meeting-management issue. The grid displays
  meetings that already exist; it does not create them.
- **Tap-to-nudge / shareable link** — issue #37.

## The view: two orientations, one toggle

A segmented toggle at the top flips the same underlying data between two projections. The cell
color language is identical in both. The toggle is presentational only — no refetch; both
projections derive from one payload.

1. **Roles × Meetings** — _coverage / "what's still open."_ Rows = the **expanded role template**
   (see Row axis below); columns = meetings; each cell = the assigned member, or an `OPEN` gap, or
   **blank** if that meeting has no such slot. Open roles read as a vertical scan down a column.
2. **Members × Meetings** — _participation / load / "who can I still ask."_ Rows = the roster
   (`members`); columns = meetings; each cell = the role(s) that member holds, marked `NA`
   (not available), or blank (free / askable). The spec's literal framing and the better
   load-balancing view.

Default orientation: **Members × Meetings**.

### Row axis — the expanded template, by union (load-bearing)

A role like **Speaker** is **one** `role_definition` with `defaultCount: 3` (seed: Speaker = 3,
Evaluator = 3). `createMeeting` expands it into 3 `role_slots` with `slot_index` 0/1/2. Therefore:

- **Roles-view rows are per-slot, not per-definition:** one row per (`role_definition`,
  `slot_index`) — Speaker yields 3 rows. Collapsing to one row per definition could not show 3
  distinct assignees or 3 distinct `OPEN` gaps.
- **The canonical row set is the _union_ of (`role_definition_id`, `slot_index`) pairs actually
  present across the windowed meetings**, ordered by (`role_definitions.sortOrder`, `slot_index`).
  Union (not "current template") guarantees a real assignment can never be hidden if a meeting was
  created under a different template, and survives the future role-template-editing feature with no
  rewrite. With today's static template it produces the same rows as the current template.
- **Blank vs OPEN are distinct:** a meeting that simply lacks a given slot renders **blank** for
  that row; a meeting that **has** the slot but no assignee renders **`OPEN`**.
- **Labels reuse `src/lib/agenda.ts`** (`buildRoleCounts` + `slotLabel`): "Speaker 1 / 2 / 3" when
  a role repeats, plain "Timer" when it does not. Do **not** introduce a separate codes module —
  extend `agenda.ts` with the short-code helper (below).

### Cell semantics & color language (shared)

v1 is **binary by assignee** — deliberately, because the claimed/confirmed meaning is unsettled:
the self-serve member flow (`club.$clubId.meeting.$meetingId.tsx`) only ever `claimSlot`s (lands
at `claimed`), and `confirmed` happens solely if an authed VPE manually confirms. Rendering
`claimed` as "tentative" would paint a self-serve club's grid as a sea of warnings. So:

| State | Meaning | Treatment |
|---|---|---|
| **Assigned** | slot has any `assigned_member_id` (`claimed` **or** `confirmed`) | solid green; role code (Members view) or member name (Roles view) |
| **Open** | slot exists, no assignee (`assigned_member_id IS NULL`, equivalently `status = 'open'`) | amber dashed `OPEN` (a cell only in the Roles view) |
| **Free** | member has no role and is not NA | muted neutral `·` (Members view only) |
| **Not available** | member marked NA for that meeting (`member_availability`) | red dashed `NA` (Members view only) |
| **Blank** | this meeting has no such slot (Roles view) | empty cell |

- **`assigned_member_id IS NULL` is the source of truth for openness** (claim/release keep it in
  sync with `status`); the per-meeting open count is `count(slots where assignee IS NULL)`.
- The payload **carries `status` (`claimed`/`confirmed`) per cell** even though v1 doesn't style
  it, so the assign-workflow follow-up can light up the distinction with zero data rework.
- In **Members × Meetings**, an individual open _role_ has no row of its own; per-meeting openness
  is surfaced through the column-header "N open" badge (see touches).

## Time window + count control

- **Count-based, cadence-agnostic.** "Next 8 meetings" is ~2 months weekly and ~4 months
  twice-monthly; the grid never needs the cadence.
- **`count` (4 / 8 / All) governs _upcoming_ meetings only** — meetings with `scheduledAt >= now`
  (now in **club timezone**, see below), ordered by date. `All` = every future meeting that exists
  (not all history).
- **Past = a fixed lookback of the 2 most-recent past meetings**, always shown, dimmed, for
  context. Not governed by `count`. There is **no** indefinite scroll into history — that lives in
  the meeting pages and activity log. Rendered columns are bounded at `2 + upcoming`.
- Column set, left→right: `[≤2 dimmed past] [first upcoming (anchor) … upcoming per count]`.

### Time boundary & anchor (club timezone — not `new Date()`)

- Past vs upcoming is computed in the **club's timezone** using the existing helpers
  (`zonedWallTimeToUtc` / the `getNextMeeting` notion), never the server or browser clock — else a
  meeting flips sides near midnight.
- The **anchor** (the blue-outlined "this-week" column the grid opens scrolled to) is the **first
  upcoming meeting**, not literal calendar-today, so a Thursday club still anchors correctly Mon–Wed.

## Visual touches (all four agreed)

1. **"N open" column-header badge** — each upcoming meeting column shows its open count (`N open`),
   or `full` when none. Past lookback columns show `done` instead (no actionable open count).
2. **Dim past + anchor** — past columns dimmed; the anchor (first upcoming) column outlined; the
   grid opens scrolled to the anchor.
3. **Sticky member/role column + sticky header row** — left labels and top dates stay pinned.
4. **Short role codes in cells** (`TM`, `Sp1`, `Ev1`, `Gram`, `Timer`) with the full label on
   hover/long-press, keeping cells narrow.

## Route & navigation

- **Repurpose `/_authed/schedule`** (currently a thin, not-in-nav meetings list) as the Season
  grid. Its existing list content is replaced.
- Add a **"Season grid"** item to the **Manage** nav group in `src/routes/_authed.tsx`, placed
  first in that group. Existing Manage items (Roster, Agenda & roles, Activity) are unchanged.

## Data layer

One read aggregation, following the **established server convention** (plain loader fn + a
`createServerFn` GET wrapper in the same module; integration test imports the plain fn and
redirects `#/db` → `tm_test`). No `-logic.ts` split — match the rest of `src/server`.

- **File:** `src/server/season-grid.ts`
  - `export async function loadSeasonGrid(input: { clubId: string; count: 4 | 8 | "all" })` —
    plain, db-using, directly testable.
  - `export const getSeasonGrid = createServerFn({ method: "GET" })…` — validates input (`zod`),
    then **requires a VPE/admin session** (`requireUser` + `requireClubRole(user.id, clubId,
    ["admin","vpe"])`, matching `createMeeting`/`confirmSlot`) before calling `loadSeasonGrid`.
    Read-only. (Revised from the original "public read acceptable" note after review: the payload
    also exposes the availability map, so the endpoint is gated even though the UI already lives
    under `_authed`. `loadSeasonGrid` stays an unguarded plain fn so integration tests call it
    directly.)
- **Returned shape** (normalized so both projections are pure client-side transforms):
  - `meetings: { id, date, openCount, totalSlots, isPast, isAnchor }[]` — the windowed columns
    (≤2 past + upcoming), date-ordered.
  - `rows: { roleDefinitionId, slotIndex, label, shortCode, sortOrder }[]` — the **union** row
    axis (expanded template), ordered by (`sortOrder`, `slotIndex`).
  - `members: { id, name }[]` — full current roster, `asc(name)`.
  - `cells: { meetingId, roleDefinitionId, slotIndex, memberId | null, status }[]` — one per real
    slot; `memberId` null ⇒ open; `status` carried for the follow-up.
  - `unavailable: { memberId, meetingId }[]` — from `member_availability`.
- **Projection:** Roles view keys cells by (row, meeting); a (row, meeting) with no cell ⇒ blank.
  Members view groups cells by (memberId, meetingId); a member/meeting with no cell and no
  `unavailable` entry ⇒ free.
- **Queries:** windowed `meetings`; `role_slots` joined to `role_definitions` for those meetings;
  `members` for the club; `member_availability` for those meetings. `openCount` =
  `count(role_slots where assigned_member_id IS NULL)` per meeting.
- **Short codes:** a deterministic heuristic in `src/lib/agenda.ts` (initials/leading letters +
  slot number when repeated), de-duplicated within a club's role set, full label preserved for the
  hover title. Custom/odd role names degrade to a clunky-but-unique code, never a wrong one. A
  curated `abbreviation` column can override this later, with role-template editing.

## Component architecture (kept small + isolated)

- `src/routes/_authed/schedule.tsx` — route + loader (calls `getSeasonGrid` with `count` from
  search params, default 8); renders the toolbar (orientation toggle + count control) and the grid.
  Reads `clubId` from router context like sibling routes.
- `src/components/club/season-grid.tsx` — presentational grid. Props: the normalized payload +
  `orientation`. Pure projection → cells; no fetching. Owns sticky layout + scroll-to-anchor.
- `src/components/club/grid-cell.tsx` — one cell. Variants: assigned / open / free / na / blank.
  **Click → navigate to `/_authed/meetings/$id` for the cell's meeting** (all variants). This is
  the **inline-assign seam:** the follow-up swaps the navigation for an assign popover keyed to
  (meeting, role-def, slot) without touching the grid.
- **Click targets overall:** any body cell **and** the date (column) header → `/_authed/meetings/$id`;
  the member row-header → `/_authed/members/$id`; the role row-label is inert.
- **Short-code helper** lives in `src/lib/agenda.ts` (extended), with tests there — no new
  `role-codes.ts`.
- Toggle + count are **URL search params** (`?view=members|roles&count=4|8|all`) so the view is
  shareable and survives reload.

## States

- **Loading:** route loader resolves before render (SSR-friendly, as siblings do); light skeleton
  if needed.
- **No meetings in window:** empty-state card — "No upcoming meetings yet," pointing at where
  meetings are created (the meeting-management surface), not a dead end. (A new club with a
  template but zero meetings has rows but no columns → same empty state.)
- **No members:** empty-state pointing at the Roster view.
- **Error:** standard toast / boundary, consistent with other `_authed` views.

## Edge cases

- **A member holding multiple slots in one meeting** (e.g. Timer + Grammarian): Members-view cell
  shows the first code with a small **`+N`**, full list on hover. Allowed by the model, rare.
- **Members view, open roles:** intentionally not rows — the header "N open" badge carries that
  signal; the Roles view shows each open slot explicitly.
- **Self-add roster noise:** all current members are rows, alphabetical, **no in-grid filtering**;
  cleanup is the VPE's job via roster mgmt (already built). "Filter/sort by load" is a noted
  follow-up if real rosters prove too noisy.
- **Removed/merged members:** grid reads current roster; historical slots follow whatever
  merge/remove already did to `role_slots` — no special-casing.
- **"All" on a 52-meeting season:** many columns; sticky + horizontal scroll keep it usable. No
  virtualization in v1 (fine at ~52 cols × ~40 rows); noted as a future optimization.

## Testing approach

- **Integration test** `src/server/season-grid.integration.test.ts` — seed a club with meetings
  (some past, some future, across club timezone), role definitions with `defaultCount > 1`, slots
  (some assigned, some open), and availability; assert `loadSeasonGrid`:
  - windows correctly (4 / 8 / All) and includes exactly the 2-meeting past lookback;
  - computes `isPast` / `isAnchor` in club timezone;
  - builds the **union** row axis with correct (`sortOrder`, `slotIndex`) ordering and expanded
    speaker/evaluator rows;
  - per-meeting `openCount` counts null-assignee slots;
  - blank (no slot) is distinguishable from open (slot, no assignee).
  Mirrors `roster-mgmt.integration.test.ts` (mocks `#/db` → `tm_test`).
- **Unit test** in `src/lib/agenda.test.ts` — short-code heuristic + de-dup.
- **Component:** light render test for `season-grid.tsx` asserting both orientations project the
  same payload correctly (assigned / open / free / na / blank in the right places).

## Out of scope / deferred (so v1 stays tight)

- Inline click-to-assign **and** the assignment/confirmation-direction decision (the immediate
  follow-up; seam + `status` carried here).
- Role-template editing incl. curated `abbreviation` column (separate issue split from #38).
- Bulk meeting creation (meeting-management issue).
- Tap-to-nudge / shareable link (#37).
- Claimed-vs-confirmed cell styling, in-grid filter/sort by load, cell virtualization.

## Open questions / risks

- **Default orientation** — set to Members × Meetings; trivial to flip.
- **Past lookback count** — fixed at 2; tunable during implementation if 1 or 3 reads better.
- **Short-code collisions** — heuristic + hover is the v1 safety net; curated column resolves it
  permanently under role-template editing.
