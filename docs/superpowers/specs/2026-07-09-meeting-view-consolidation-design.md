# Collapse the signed-in "agenda" screen into a single meeting view

**Issue:** #141. Follow-on (deferred): #145 (fold in the public self-asserted view).
**Date:** 2026-07-09 (revised after grilling — see "Design evolution" at the end).
**Scope:** Eliminate the separate signed-in `/agenda` screen. There is **one** signed-in meeting/agenda view — `/meetings/$id` — and the sidebar's former "Agenda & roles" entry becomes a **"Next meeting"** shortcut that resolves to the next meeting's page. Does **not** touch the public club view (`club.$clubId.meeting.$meetingId.tsx`) — that's #145.

## Problem

There are two signed-in single-meeting screens that expose **different capabilities for the same data**, and the split between "agenda" and "meeting" is itself artificial — an agenda *is* a meeting's agenda:

| Screen | File | Loader | Manage (assign/confirm/move) | Sign up | Stats | Print/Present/Nav |
|---|---|---|---|---|---|---|
| `/agenda` (next meeting) | `src/routes/_authed/agenda.tsx` | `getNextMeeting` | ❌ | ✅ | ✅ tiles + roles-filled % | Print + Present, **no nav** |
| `/meetings/$id` (by id) | `src/routes/_authed/meetings.$id.tsx` | `getMeeting` | ✅ | ✅ | ❌ | Print + Present + nav |

`/agenda` is also a **dead end**: it shows only "the next meeting" with no way to page to another meeting. Everything unique to it is either cosmetic (the dashboard framing → kept as a stats strip) or a convenience ("take me to the next meeting" → kept as a redirect). So rather than maintain two renderers of the same thing, we collapse to one.

## Approach

**One meeting view; the agenda entry becomes a shortcut.**

- `/meetings/$id` is the single meeting/agenda view. It already has roster management, print/present, and the prev/next nav strip (from #140/#142). We add the stats strip onto it.
- `/agenda` is replaced by a thin resolver route at **`/next`** that redirects (loader-level) to `clubs[0]`'s next meeting's `/meetings/$id`, or renders the "nothing scheduled" empty state when there's no upcoming meeting.

This kills the dual concept, removes the dead end (from the next meeting you can page anywhere via the nav strip + the season grid), and is *less* code than a shared-component extraction — there is only one renderer, so no shared component is needed.

## Design

### 1. Enrich `/meetings/$id` (the single view)

`src/routes/_authed/meetings.$id.tsx` — add, above the category sections:

- **Stats strip** derived from a new pure `summarizeAgenda(slots)`: open roles, confirmed count, prepared-speeches count, and the roles-filled % progress bar. (Theme/date/WoD already live in the header; not repeated.)
- **"Remind unfilled" stub button** (canManage only), carried over from `/agenda` — same non-functional stub (toasts "Reminder sending isn't wired up yet"). It's a signpost for #7; kept rather than silently dropped.

Everything else on `/meetings/$id` is unchanged (management actions, nav strip, print/present, unavailable-members section, edit-meeting). Slot rows keep their current `/meetings/$id` style — `/agenda`'s avatar/numbered "sign-up card" is **not** carried over.

### 2. Replace `/agenda` with the `/next` resolver

- **Delete** `src/routes/_authed/agenda.tsx` (its bespoke dashboard, sign-up card, and its private `ClaimSpeakerSheet` copy go with it — dropping the triple-duplicated sheet to two copies; #145 removes the last from the public view).
- **Create** `src/routes/_authed/next.tsx` at path `/next`:
  - **Loader:** resolve `clubs[0]`'s next meeting via `getNextMeeting`. If a meeting exists, `throw redirect({ to: "/meetings/$id", params: { id: meeting.id } })`. If there's no club or no upcoming meeting, return `{ meeting: null }`.
  - **Component:** render the existing "No upcoming meeting is scheduled yet" empty state (with the canManage "Schedule a meeting" CTA to `/admin/meetings/new`). It only renders in the no-meeting case; the meeting case always redirects.
  - Reusing `getNextMeeting` (which returns full detail) purely to read `meeting.id` is mildly wasteful but avoids a new server-fn; acceptable (a lightweight id-only fetch is a possible later optimization, not needed now).

### 3. Rename the sidebar entry + update all inbound links

- `src/routes/_authed.tsx`:
  - Nav item: label **"Next meeting"**, `to="/next"` (keep the `CalendarDays` icon). It's a plain shortcut — **no persistent active state** (it always redirects to `/meetings/$id`, which is also reached from the season grid and `/me` for arbitrary meetings, so highlighting it for `/meetings/*` would be misleading).
  - `crumbFor`: remove the `/agenda` mapping. `/meetings` already maps to "Manage · Meeting", which covers the landing page.
- Repoint every inbound `/agenda` link to `/next` (all are "go sign up / assign roles" intents that map cleanly to "the next meeting"):
  - `src/routes/_authed/dashboard.tsx` — three `to="/agenda"` links + the `to: "/agenda" | "/resources"` prop type.
  - `src/routes/_authed/index.tsx` — `to: "/agenda" as const` and the `to?: "/agenda"` type.
  - `src/routes/_authed/members.$id.tsx` — the `<Link to="/agenda">Assign a role</Link>`.

### 4. Route tree regeneration

Removing `/agenda` and adding `/next` changes the file-based routes, so `src/routeTree.gen.ts` legitimately changes. Regenerate it with **`bun run generate-routes`** (NOT `bun run build`, which additionally appends an SSR Register block) and commit the regenerated file.

### 5. Testable seam

Add a pure function to `src/lib/agenda.ts`:
```
summarizeAgenda(slots) => {
  total, filled, open, pct, confirmed, speakerTotal, speakerFilled
}
```
Unit-test in `src/lib/agenda.test.ts`: counts, percentage rounding, and empty-slots → `pct: 0`. Everything else is interaction/redirect behavior, verified live via `/browse`; the slot server-fns already have integration coverage for the write paths.

## Scope boundaries (non-goals)

- **No public view.** `club.$clubId.meeting.$meetingId.tsx` is untouched — folding it in (reconciling self-asserted `isTmod` vs session `canManage`, availability/takeover vs confirm/move-speaker) is **#145**.
- **No shared-component extraction** — collapsing to a single renderer makes it unnecessary.
- **No identity-model changes**; `canManage`/`currentMemberId` still come from `loadMeetingDetail` + the `_authed` context.
- **No multi-club change**: `/next` still resolves `context.clubs[0]`'s next meeting (that seam stays #10).
- **No reminders wiring** — the "Remind unfilled" button stays a stub (#7).

## Error / edge handling

- `/next` with no club or no upcoming meeting → renders the empty state (no redirect).
- `/next` with a meeting → loader-level `redirect` (no flash; canonical URL becomes `/meetings/$id`).
- Inbound `/agenda`→`/next` links all resolve through the same redirect/empty-state logic.
- `/meetings/$id` stats strip renders for any meeting (including past ones drilled from the season grid) — historical counts are harmless.
- `MeetingNavStrip` already returns null for ≤1 meeting; unchanged.

## Files touched

- `src/routes/_authed/meetings.$id.tsx` — add stats strip (`summarizeAgenda`) + "Remind unfilled" stub (canManage)
- `src/routes/_authed/agenda.tsx` — **delete**
- `src/routes/_authed/next.tsx` — **create** (resolver: redirect to next meeting, or empty state)
- `src/routes/_authed.tsx` — nav item → "Next meeting" / `to="/next"`; drop `/agenda` crumb
- `src/routes/_authed/dashboard.tsx` — `/agenda` → `/next` (3 links + prop type)
- `src/routes/_authed/index.tsx` — `/agenda` → `/next` (link + type)
- `src/routes/_authed/members.$id.tsx` — `/agenda` → `/next`
- `src/lib/agenda.ts` — add `summarizeAgenda`
- `src/lib/agenda.test.ts` — add `summarizeAgenda` tests
- `src/routeTree.gen.ts` — regenerated via `bun run generate-routes`

## Risk

Lower than a component-merge refactor. Main risks: a stale `/agenda` link left behind (TypeScript's typed routes will actually **catch** these — `to="/agenda"` won't type-check once the route is gone), and the redirect/empty-state edges. Mitigations: rely on `tsc` to surface missed links, regenerate the route tree, and verify via `/browse` that `/next` redirects (and shows the empty state when nothing's scheduled), the sidebar reads "Next meeting", `/meetings/$id` shows the stats strip, and every former `/agenda` entry point lands correctly.

## Design evolution

The first draft of this spec extracted a shared `<MeetingAgenda>` component rendered by *both* `/agenda` and `/meetings/$id`. Grilling surfaced that the `/agenda` vs `/meeting` split was itself the smell — a second name and a dead-end route for a thing we already have. Collapsing to one view + a redirect shortcut removes the dual concept, eliminates the dead end, and is less code than the shared-component approach. Decisions locked during grilling: (1) unified rows use `/meetings/$id`'s style; (2) no capabilities abstraction now (that's #145); (3) test via a pure `summarizeAgenda` + `/browse`, no new router/RTL harness; (4) rename to "Next meeting" / `/next`, no persistent nav highlight; (5) keep the "Remind unfilled" stub, moved into the unified view.
