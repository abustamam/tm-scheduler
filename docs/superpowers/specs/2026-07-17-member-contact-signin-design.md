# Member contact info for signed-in members — design

**Date:** 2026-07-17
**Branch:** `worktree-member-contact-signin`
**Status:** design (awaiting spec review)

## Problem

The club's Google spreadsheet shows each member's email and phone alongside the
role sign-up grid, which officers rely on to chase people for assignments. Our
sign-up sheet shows names only. We want the same contact info in the app —
**but** the public sheet at `/club/:clubId` is only behind a soft "pick your
name" gate (localStorage, no real login; anyone with the link can view it, and
anyone can even add themselves — see `require-member.tsx`). Publishing email +
phone there would expose every member's contact details to anyone the link
reaches.

## Decision

Contact info (email + phone) is visible to **signed-in members only**. It never
appears on the public `/club/:clubId` sheet.

- **Placement:** both (1) inline **Email + Phone columns** in the Members ×
  Meetings orientation of the authed `/schedule` grid, and (2) a **contact
  block on the member profile page** (`/members/:id`, already signed-in-only).
- **Axis:** unchanged — the Members × Meetings axis stays **active-members-only**.
  Contact columns just annotate the existing rows.
- **Share link:** also add a **"Copy sign-up sheet link"** button to the authed
  `/schedule` header (reusing the existing `ShareLinkButton`) that yields
  `/club/<slug>` — answering "where does an officer get the public link", which
  today has no UI anywhere.

## Architecture

The grid component (`src/components/club/season-grid.tsx`) is shared by the
public club shell (`/club/:clubId`) and the authed `/schedule`. Both entry
points call the same loader (`loadSeasonGrid` in `season-grid-logic.ts`) through
two server fns (`getPublicSeasonGrid`, `getSeasonGrid` in `season-grid.ts`).

Therefore the gate lives in the **data layer, not the component**: the public
server fn must never return contact fields. Hiding columns client-side is not
acceptable — the payload would still carry the PII to the browser.

### 1. Data layer — `src/server/season-grid-logic.ts`

- Extend `SeasonGridMember`:
  ```ts
  export interface SeasonGridMember {
      id: string;
      name: string;
      email?: string | null; // present only when contact is included
      phone?: string | null;
  }
  ```
  Optional fields keep every existing consumer (roles orientation, `memberNames`,
  `guestNames`, tests) source-compatible.
- Add a parameter to `loadSeasonGrid`:
  ```ts
  export async function loadSeasonGrid(input: {
      clubId: string;
      count: SeasonGridCount;
      includeContact?: boolean; // default false
  }): Promise<SeasonGridData>
  ```
  When `includeContact` is true, the active-member query (currently
  `season-grid-logic.ts:233-240`) also selects `members.email` / `members.phone`
  and maps them onto the `members` axis rows. When false/omitted, the select and
  the mapped objects are exactly as today (no contact keys).
  - Contact goes on the `members` axis **only**. `memberNames` (the all-members
    incl-inactive name lookup used by the roles orientation) does **not** carry
    contact — it never needs it.

### 2. Server fns — `src/server/season-grid.ts`

- `getSeasonGrid` (authed): pass `includeContact: true` into `loadSeasonGrid`.
  It already requires `requireUser()` + `requireClubViewAccess`, so any member of
  the club may view it — matching "signed-in members only".
- `getPublicSeasonGrid` (public): pass `includeContact: false` (or omit). This is
  the gate — the public payload never contains contact.

### 3. Grid columns — `src/components/club/season-grid.tsx`

- New prop: `showContact?: boolean` (default false). Only `/schedule` sets it
  true; the public club shell leaves it false.
- Contact columns render **only** when `orientation === "members" && showContact`.
- Build a `contactByMember = new Map(data.members.map(m => [m.id, m]))` lookup.
- Header: after the meeting `<th>`s, append `<th>Email</th><th>Phone</th>`
  (same sticky-top treatment as meeting headers; left-aligned).
- Body rows: after the meeting `<td>`s, append two cells resolving
  `contactByMember.get(row.memberId)`:
  - Email → `<a href="mailto:…">` when present, `—` when null.
  - Phone → `<a href="tel:…">` when present, `—` when null.
  - Roles orientation rows have no `memberId` and never reach here (guarded by
    `showContact` + orientation).
- The existing "no members" empty-state return is unaffected (members
  orientation only, and it short-circuits before the table).

### 4. `/schedule` route — `src/routes/_authed/schedule.tsx`

- Pass `showContact` to `<SeasonGrid>`. It is meaningful only in the members
  orientation; passing it unconditionally is fine (the component gates on
  orientation).
- Add the **"Copy sign-up sheet link"** button to the page header next to the
  `<h1>`, using `ShareLinkButton` with
  `path={`/club/${clubSlug}`}`. Need the club **slug** — source it the same way
  the meeting view does (`meetings.$id.tsx:323` uses `clubSlug`); confirm the
  slug is available in this route's context (`activeClub` / route context) during
  implementation and thread it in if not already present.

### 5. Member profile — `src/routes/_authed/members.$id.tsx` (display only)

- `getMemberProfile` already returns `member.email` / `member.phone` (the Edit
  dialog consumes them at `members.$id.tsx:661,671`), and the route is under
  `_authed`. So this is **pure display — no server change**.
- Add a small contact row to the profile header meta area (under the tenure /
  "joined" line, near `members.$id.tsx:150-153`): email as `mailto:`, phone as
  `tel:`, each omitted when null. Keep it visually consistent with the existing
  header meta styling (`text-[var(--sea-ink-soft)]`, lucide `Mail` / `Phone`
  icons for affordance).

## Security / privacy

- The public sheet payload (`getPublicSeasonGrid`) carries **no** contact fields
  — verified by a unit test, not by trusting the UI.
- Contact reaches the browser only through authenticated server fns
  (`getSeasonGrid`, `getMemberProfile`), both already gated by `requireUser()` /
  `_authed`.
- No schema/migration change — the columns already exist (`members.email`,
  `members.phone`).

## Testing

- **`season-grid-logic` unit tests** (extend the existing suite): with
  `includeContact: true`, `members` rows carry `email`/`phone`; with
  `includeContact` false/omitted, the member objects have no contact keys.
- **`server-modules.guard.test.ts`** already enforces that `season-grid.ts`
  exports only server fns + types (keeps `#/db` out of the client bundle) — no
  change needed, but it must still pass.
- **`projectGrid`** is unaffected (it reads `id`/`name` off members); a quick
  assertion that it ignores the extra keys is enough.
- Manual/verify pass: `/schedule` in members orientation shows Email + Phone
  columns with working `mailto:`/`tel:` links; the public `/club/:slug` sheet
  shows **no** contact; profile page shows the contact row; the copy-link button
  copies `/club/<slug>`.

## Non-goals / out of scope

- No change to who can *edit* contact (still the existing admin Edit dialog).
- No change to the public sheet's access model (still the soft pick-name gate).
- No contact columns in the Roles × Meetings orientation (members are in cells
  there — no natural per-member row).
- No officer-vs-member distinction: any signed-in club member sees contact, per
  the "signed-in members only" decision.
