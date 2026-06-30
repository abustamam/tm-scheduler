# GavelUp — VPE Season Grid Design

- **Date:** 2026-06-30
- **Status:** Approved (brainstorm + visual companion complete); ready for implementation plan
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
  shape ready for it.
- **Role-template editing** (role definitions: counts, order, descriptions) — split into its own
  issue out of #38.
- **Bulk-creating future meetings** — stays in the meeting-management issue. The grid displays
  meetings that already exist; it does not create them.
- **Tap-to-nudge / shareable link** — issue #37.

## The view: two orientations, one toggle

A segmented toggle at the top flips the same underlying data between two projections. The cell
color language is identical in both.

1. **Roles × Meetings** — _coverage / "what's still open."_ Rows = the club's role template
   (`role_definitions`, in template order); columns = meetings; each cell = the assigned member,
   or an `OPEN` gap. Open roles read as a vertical scan down a meeting column.
2. **Members × Meetings** — _participation / load / "who can I still ask."_ Rows = the roster
   (`members`); columns = meetings; each cell = the role that member holds, marked `NA`
   (not available), or blank (free / askable). This is the spec's literal framing and the better
   load-balancing view.

Default orientation: **Members × Meetings** (matches the spec and the "who to ask" workflow). The
toggle is presentational only — no refetch needed; both projections derive from one payload.

### Cell semantics & color language (shared)

| State | Meaning | Treatment |
|---|---|---|
| **Filled** | member is assigned to a role | solid green, role code (Members view) or member name (Roles view) |
| **Open** | a role slot with no assignee | amber dashed `OPEN` (only appears as a cell in Roles view; in Members view openness is surfaced via the column-header badge, below) |
| **Free** | member has no role and is not NA | muted neutral `·` (Members view only) |
| **Not available** | member marked NA for that meeting (`member_availability`) | red dashed `NA` (Members view only) |

In **Members × Meetings**, an individual open _role_ has no row of its own, so per-meeting
openness is surfaced through the column-header "N open" badge (see touches).

## Time window + count control

- **Count-based, cadence-agnostic** window. "Next 8 meetings" is ~2 months for a weekly club and
  ~4 months for a twice-monthly club, with the grid never needing to know the cadence.
- **Default:** the next **8** meetings, anchored on the current/this-week meeting, **horizontally
  scrollable** left into the past and right to the rest of the season.
- **Count control** (segmented, top bar): **4 / 8 / All**. "All" widens to the whole season for a
  monthly-maintenance pass where the VPE fills everything at once.
- The window is a count of meetings ordered by date, centered so a few recent past meetings remain
  visible for context while the emphasis is forward.

## Visual touches (all four agreed)

1. **"N open" column-header badge** — each meeting column header shows its open-role count
   (`N open`), or `full` when none are open. Cross-cutting, so the Members view still reveals
   where gaps are without flipping orientation.
2. **Dim past + anchor on today** — past-meeting columns are dimmed; the current/this-week column
   gets a blue outline; the grid opens scrolled to "today."
3. **Sticky member/role column + sticky header row** — the left label column and the top date row
   stay pinned while scrolling the grid body.
4. **Short role codes in cells** (e.g. `TM`, `Sp1`, `Ev1`, `Gram`, `Timer`) with the full role
   name on hover/long-press, keeping cells narrow so more meetings fit.

## Route & navigation

- **Repurpose `/_authed/schedule`** (currently a thin, not-in-nav meetings list) as the Season
  grid. Its existing list content is replaced.
- Add a **"Season grid"** item to the **Manage** nav group in `src/routes/_authed.tsx`, placed
  first in that group (it is the VPE's primary planning surface). Existing Manage items (Roster,
  Agenda & roles, Activity) are unchanged.

## Data layer

One read aggregation, following the **established server convention** (plain loader fn + a
`createServerFn` GET wrapper in the same module; integration test imports the plain fn and
redirects `#/db` → `tm_test`). No `-logic.ts` split — match what the rest of `src/server` does today.

- **File:** `src/server/season-grid.ts`
  - `export async function loadSeasonGrid(input: { clubId: string; count: 4 | 8 | "all" })` —
    plain, db-using, directly testable.
  - `export const getSeasonGrid = createServerFn({ method: "GET" })…` — validates input
    (`zod`), calls `loadSeasonGrid`. Read-only; **public read is acceptable** (mirrors the
    existing public reads), but the route lives under `_authed`, so only the VPE reaches it in UI.
- **Returned shape** (normalized so both views project cheaply without re-querying):
  - `meetings: { id, date, openCount, totalSlots, isPast }[]` (windowed, date-ordered)
  - `roleDefinitions: { id, name, shortCode, order }[]` (template order)
  - `members: { id, name }[]` (active roster, `asc(name)`)
  - `slots: { meetingId, roleDefinitionId, slotIndex, shortCode, memberId | null }[]`
    (the assignment grid; `memberId` null ⇒ open)
  - `unavailable: { memberId, meetingId }[]` (from `member_availability`)
- **Queries:** windowed `meetings`; `role_slots` joined to `role_definitions` for the window;
  `members` for the club; `member_availability` for the window. Open count per meeting derived
  from slots with `status = 'open'` / null assignee.
- **`shortCode`:** derived from the role definition name (a small deterministic mapping/helper in
  `src/lib/`), so codes are stable and the full name is available for the hover title. (If we want
  curated codes later, that becomes a `role_definitions` column under the role-template issue.)

## Component architecture (kept small + isolated)

- `src/routes/_authed/schedule.tsx` — route + loader (calls `getSeasonGrid` with the count from
  search params, default 8); renders the toolbar (toggle + count control) and the grid. Reads
  `clubId` from router context like the sibling routes.
- `src/components/club/season-grid.tsx` — presentational grid. Props: the normalized payload +
  `orientation`. Pure projection → cells; no data fetching. Houses sticky layout + scroll anchor.
- `src/components/club/grid-cell.tsx` — one cell. Variants: filled / open / free / na. Click →
  navigate to `/_authed/meetings/$id` for the cell's meeting. **This is the seam for inline
  assign:** the follow-up swaps the navigation for an assign popover without touching the grid.
- `src/lib/role-codes.ts` — name → short code helper (+ tests).
- Toggle + count are **URL search params** (`?view=members|roles&count=4|8|all`) so the view is
  shareable/bookmarkable and survives reload.

## States

- **Loading:** route loader resolves before render (SSR-friendly, as siblings do); a light
  skeleton if needed.
- **No meetings in window:** empty-state card — "No upcoming meetings yet" with a pointer to where
  meetings are created (the meeting-management surface), not a dead end.
- **No members:** empty-state pointing at the Roster view to add members.
- **Error:** standard toast / boundary consistent with the other `_authed` views.

## Edge cases

- **A member holding two roles in one meeting** (e.g. Timer + Grammarian): render the primary role
  code with a small `+1` affordance; full list on hover. Rare but real.
- **Members view, open roles:** intentionally not rows — the header "N open" badge carries that
  signal; the Roles view is the place to see each open role explicitly.
- **Removed/merged members** (post roster-mgmt): grid reads current roster; historical assignments
  to a removed member follow whatever the merge/remove already did to `role_slots` — the grid does
  not special-case it.
- **"All" on a 52-meeting season:** many columns; sticky + horizontal scroll keep it usable. No
  virtualization in v1 (acceptable at ≤ ~52 cols × ~40 rows); note as a future optimization.

## Testing approach

- **Integration test** `src/server/season-grid.integration.test.ts` — seed a club with meetings,
  role definitions, slots (some assigned, some open), and availability; assert `loadSeasonGrid`
  returns correct windowing (4/8/all), per-meeting open counts, `isPast` flags, and that
  unassigned slots surface as open. Mirrors `roster-mgmt.integration.test.ts` (mocks `#/db` →
  `tm_test`).
- **Unit test** `src/lib/role-codes.test.ts` — name → short-code mapping.
- **Component:** light render test for `season-grid.tsx` asserting both orientations project the
  same payload correctly (filled / open / free / na cells in the right places).

## Out of scope / deferred (so v1 stays tight)

- Inline click-to-assign (the immediate follow-up; seam is built in here).
- Role-template editing (separate issue split from #38).
- Bulk meeting creation (meeting-management issue).
- Tap-to-nudge / shareable link (#37).
- Cell virtualization / very-large-season perf work.

## Open questions / risks

- **Default orientation** — set to Members × Meetings; trivial to flip if the VPE prefers opening
  on coverage.
- **Window anchoring** — "a few past meetings visible" is a soft rule; exact count of trailing past
  columns can be tuned during implementation.
- **Short codes from names** — heuristic mapping is fine for v1; if collisions are ugly, the
  curated-code column waits for the role-template issue.
