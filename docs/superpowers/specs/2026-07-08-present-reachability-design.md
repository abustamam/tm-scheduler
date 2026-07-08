# Present/Print reachability from the signed-in app

**Issue:** #140 (umbrella: route-tree divergence). Also satisfies #142 (prev/next nav).
**Date:** 2026-07-08
**Scope:** Reachability only — make the existing public club meeting pages (Present, Print, prev/next) reachable from the signed-in workspace. Does **not** merge the meeting screens (#141) or add role-to-existing-meeting (#143).

## Problem

The app has two route trees:

| Tree | URLs | Identity model |
|---|---|---|
| `_authed/*` (signed-in workspace) | `/agenda`, `/meetings/$id`, `/dashboard`, `/admin/*` | Better-Auth session — `canManage` / `currentMemberId` from route context |
| `club/*` (public club pages) | `/club/$clubId/meeting/$meetingId`, `.../present`, `.../print` | Self-asserted "pick your name" — `useCurrentMember` / `isTmod` (ADR-0010) |

Present mode (`/club/$clubId_/meeting/$meetingId/present`) and the multi-layout Print page
(`.../print`) were built on the `club/*` tree and are linked **only** from
`src/routes/club.$clubId.meeting.$meetingId.tsx`. Nothing under `src/routes/_authed/*` links
to them, so a signed-in VPE has no way to reach Present at all, and Print only from `/agenda`.
`MeetingNavStrip` (prev/next) is likewise wired only into the public club route.

## Key facts that shape the design

- **Present and Print are auth-agnostic standalone pages.** Their routes use the `$clubId_`
  escape suffix, so they render outside the club shell, load purely from
  `getMeeting` + `resolveClubOrRedirect`, and need no member identity. They accept a
  `clubId` (slug works) + `meetingId`. `agenda.tsx` already opens Print this way
  (`agenda.tsx:184`), using the `clubSlug` its loader returns.
- **`meetings.$id.tsx` already has `clubSlug`** in its loader data (from `getMeeting`), so it
  can build the same links with no loader change for Present/Print.
- **`MeetingNavStrip` hardcodes its destination** to `/club/$clubId/meeting/$meetingId`
  (`meeting-nav-strip.tsx:40`). Reusing it verbatim in `_authed` would navigate the user out
  of the workspace into the public tree — the exact divergence trap. Its item builder,
  `buildMeetingNavItems`, is already pure and route-agnostic.

## Approach

Link the signed-in views to the existing public standalone pages (rather than cloning them
into `_authed`, which would re-introduce divergence). The only non-trivial change is making
`MeetingNavStrip`'s link destination swappable so prev/next can stay inside the workspace.

## Design

### 1. Shared `<MeetingViewActions>` component

New presentational component (e.g. `src/components/club/meeting-view-actions.tsx`) so the two
signed-in views cannot re-diverge on these affordances:

```
MeetingViewActions({ clubSlug, meetingId, printLayout = "timing" })
  → "Print agenda"  Link → /club/$clubId/meeting/$meetingId/print?layout=<printLayout>
                    (target="_blank", rel="noopener noreferrer", Printer icon)
  → "Present"       Link → /club/$clubId/meeting/$meetingId/present
                    (target="_blank", rel="noopener noreferrer", Presentation icon)
```

- `agenda.tsx`: replace its inline Print `<Link>` (`agenda.tsx:183-193`) with
  `<MeetingViewActions clubSlug={clubSlug} meetingId={meeting.id} />` — gains Present.
- `meetings.$id.tsx`: add `<MeetingViewActions clubSlug={clubSlug} meetingId={meeting.id} />`
  in the header — gains both Print and Present.

Match the button styling already used in the header regions (shadcn `Button asChild variant="outline" size="sm"`).

### 2. Route-agnostic `MeetingNavStrip` (prev/next; satisfies #142)

- Add an optional prop to `MeetingNavStrip`:
  `getLinkProps?: (meetingId: string) => { to: string; params: Record<string, string> }`.
  **Default** (prop omitted) preserves today's behavior:
  `{ to: "/club/$clubId/meeting/$meetingId", params: { clubId, meetingId } }` — the public
  route is untouched.
- `meetings.$id.tsx` loader: additionally call
  `listUpcomingMeetings({ data: <meeting.clubId uuid> })` (non-fatal — degrade to no strip on
  failure, mirroring the club route at `club.$clubId.meeting.$meetingId.tsx:80-82`), compute
  the current meeting's open-slot count from its own loaded slots, and build `navItems` with
  `buildMeetingNavItems`. Render `<MeetingNavStrip>` passing `getLinkProps` that targets
  `/meetings/$id` (`{ to: "/meetings/$id", params: { id: meetingId } }`) so paging stays in
  the workspace.
- `agenda.tsx`: **no strip** — it is definitionally "the next meeting," so prev/next has no
  meaning there.

### 3. Scope boundaries (non-goals)

- Does **not** merge the three meeting renderings (`agenda.tsx`, `_authed/meetings.$id.tsx`,
  `club.$clubId.meeting.$meetingId.tsx`) or reconcile the two identity models — that is #141.
- Does **not** add a role-definition slot to existing meetings — that is #143.
- `agenda.tsx` continues to read `context.clubs[0]`; the multi-club seam stays #10/#141.

## Error / edge handling

- No `clubSlug` or no meeting → render no actions. `agenda.tsx`'s empty state already returns
  before the header, so nothing to guard there; `meetings.$id.tsx` always has a meeting (loader
  throws/`notFound` otherwise).
- `MeetingNavStrip` already returns `null` when `items.length <= 1`.
- The upcoming-meetings fetch in the `meetings.$id` loader is non-fatal: a failure degrades to
  no strip, never blocks the page.
- New-tab links to Present/Print are unaffected by auth — the target pages are public.

## Testing

- `buildMeetingNavItems` is already pure and covered; no change.
- Add a small unit test asserting `MeetingNavStrip`'s default `getLinkProps` yields the public
  `/club/$clubId/meeting/$meetingId` target and a supplied builder yields `/meetings/$id`
  (guards the divergence trap from regressing).
- Verify wiring live via `/browse`: from a signed-in `/meetings/$id`, Print and Present open
  the correct public URLs in a new tab, and the prev/next strip pages between meetings while
  staying under `/meetings/$id` (never jumping to `/club/...`).

## Files touched

- `src/components/club/meeting-view-actions.tsx` (new)
- `src/components/club/meeting-nav-strip.tsx` (add optional `getLinkProps`)
- `src/routes/_authed/agenda.tsx` (swap inline Print link for `MeetingViewActions`)
- `src/routes/_authed/meetings.$id.tsx` (add `MeetingViewActions`; loader fetches upcoming; add `MeetingNavStrip`)
- test for `MeetingNavStrip` link targets
