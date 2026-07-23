# Unify the two meeting views into one canonical page

**Date:** 2026-07-22
**Status:** Approved (design) — ready for implementation plan
**Related:** #145, #148 (meeting-view consolidation), #317/#302 (signed-in member parity), #320 (preview-as-member), aa41855 (date-based meeting URLs), #176 (offline read-only + minutes queue)

## Problem

The same meeting is reachable through two different UIs:

- `https://gavelup.app/club/thr-speaking-club/meeting/2026-07-25` — the public / self-serve view (`src/routes/club.$clubId.meeting.$meetingId.tsx`).
- `https://gavelup.app/meetings/c5df11cd-…` — the signed-in management view (`src/routes/_authed/meetings.$id.tsx`).

Two URLs, two layouts, two capability models for one resource. This is confusing and doubles the maintenance surface. We want **one canonical meeting page** at the pretty URL `/club/:clubId/meeting/:key`, whose experience adapts to who is looking.

## Current state (why this is tractable)

The hard infrastructure already exists:

- `club.$clubId.tsx` `beforeLoad` already **shell-wraps** a signed-in member of the viewed club (full `AppShell` + session identity), switching the active club first when needed (`publicShellDecision`).
- The pretty route already loads session-aware for shell members (`getMeetingByKey`) and PII-safe for anonymous visitors (`getPublicMeetingByKey`).
- Both routes already render the same shared `<MeetingAgenda>` driven by a `meetingViewer(...)` capability object.
- The nav strip already defaults to the pretty URL (`deriveMeetingNavItems` → `urlKey`).

The **only** reason a signed-in admin doesn't get management on the pretty URL today is that `club.$clubId.meeting.$meetingId.tsx` **hardcodes `canManage: false`** and omits the management-only sections. So unification is composition + routing work, not new domain logic.

## What each route has today

| | Pretty route (public) | `/meetings/:id` (authed) |
|---|---|---|
| Data | `getMeetingByKey` (shell) / `getPublicMeetingByKey` (anon) | `getMeeting` |
| `canManage` | hardcoded `false` | real, from session |
| Agenda | ✓ (`<MeetingAgenda>`) | ✓ (`<MeetingAgenda>`) |
| Availability toggle / attendance | ✓ | — |
| Projected-end timing chip | ✓ | — |
| Guest resources | ✓ | — |
| "Viewing as / not you?" | ✓ | — |
| Share / Present / Print / PPTX | ✓ | ✓ |
| Minutes | — | ✓ |
| Role sheets · Add role · Complete/Reopen · Preview-as-member | — | ✓ |
| Offline banner | — | ✓ |
| Container width | `max-w-reading` | `PageContainer` |

## Design

### Approach

**One shared `<MeetingDetailPage>` component.** The pretty-URL route becomes a thin wrapper that loads data, computes the `viewer`, and renders it. `/meetings/:id` shrinks to a redirect. Management-only sections render inside the component gated on `viewer.canManage`. This keeps each route file small and leans on the existing `meetingViewer` / `<MeetingAgenda>` seam. (Approaches "grow the pretty route in place" and "shared hook" were considered and rejected — the first balloons one file mixing three audiences; the second adds indirection this doesn't need.)

### Routing

**Canonical route — `club.$clubId.meeting.$meetingId.tsx`:**

- Loader keeps the `shell ? getMeetingByKey : getPublicMeetingByKey` fork **verbatim** — this is the PII boundary (see below).
- **New:** when `shell`, also load `getMinutes(meeting.id)` and (admin + locked) `getMinutesRecipients`, both non-fatal (degrade to hidden), mirroring `/meetings/:id`'s loader. Anonymous payloads never load minutes.
- Renders `<MeetingDetailPage>`.
- Nav strip targets the pretty URL (drop the `/meetings/$id` `getLinkProps` override that the authed route used).

**`_authed/meetings.$id.tsx` → redirect stub:**

- Loader resolves the meeting's `clubSlug` + `urlKey` via a small `resolveMeetingUrl(id)` server fn (gated by club view access; unknown/forbidden id → `notFound()`), then `throw redirect({ to: "/club/$clubId/meeting/$meetingId", params: { clubId: slug, meetingId: urlKey } })`.
- **Redirect target is the pretty date-key form** (fulfills the canonical-pretty-URL intent). The raw-uuid form of the pretty URL still resolves as a stable fallback for anyone holding one.
- Component body deleted. Every existing `/meetings/$id` link keeps working via this one redirect hop.
- Stays under `_authed` (was always authed; the redirect resolver uses the session).

### `<MeetingDetailPage>` component

Renders the whole page from loader data + a computed `viewer`. Section visibility by audience:

| Section | Anon | Member (signed-in, non-admin) | Admin |
|---|---|---|---|
| Header (theme, date, **projected-end timing**, location, nav strip, WOD) | ✓ | ✓ | ✓ |
| `<MeetingAgenda>` | read + claim (after name pick) | self-serve claim / take-over | full manage |
| Availability toggle / attendance statement | ✓ | ✓ | **✓** (see decision) |
| Guest resources | ✓ | ✓ | hidden (reachable via Preview-as-member) |
| Share link · Present · Print · PPTX | ✓ | ✓ | ✓ |
| "Viewing as / not you?" | ✓ (anon pick) | — | — |
| Minutes | ✗ | per `getMinutes` visibility (`completed`) | ✓ edit |
| Role sheets · Add role · Complete/Reopen · Preview-as-member | ✗ | ✗ | ✓ |
| Offline banner | ✗ | ✓ | ✓ |
| Container width | reading | reading | wider (`PageContainer`) |

### Viewer computation (unifies both routes' logic)

Editing window must branch on capability so both current behaviors are preserved exactly:

```
locked      = isMeetingLocked(status)
datePassed  = meetingDatePassed(scheduledAt, tz)
over        = locked || datePassed
// admins keep editing a past-but-open meeting until Complete; members/anon freeze once the date passes
editable    = canManage ? !locked : !over
base        = meetingViewer({ currentMemberId, canManage, isTmod, isGrammarian, isEditableWindow: editable, isSignedIn })
viewer      = (canManage ? locked : over) ? lockedViewer(base) : base
```

Result: admin edits until Complete; member/anon agenda freezes after the meeting date and shows the "You attended / did not attend" statement instead of the RSVP toggle.

### Actions object picked by capability (privilege-critical)

The two routes build **different** `actions` objects; the unified component must pick by capability to preserve the server's ADR-0010 self-serve-vs-admin authz split verbatim:

- **Manager (`canManage`):** admin actions — `actorMemberId` = the session member, **no** `selfMemberId`, plus the manager-only `confirm` / `unconfirm` / `moveSpeaker` / `removeRole`.
- **Member / anon:** self-serve actions — `requireIdentity()` → `selfMemberId` on every mutation (server takes the self-serve path).

This is the single place a sloppy merge would introduce a privilege bug, so it is called out explicitly and gets a unit test.

## Decisions (resolved during design + grill)

1. **Old URL fate:** `/meetings/:id` redirects to the pretty date-key URL. Not kept as a second live view; not hard-removed (old bookmarks keep working through the redirect).
2. **Redirect target:** the pretty **date-key** form, not the stable uuid. The uuid alias remains as the stable fallback. Reschedule fragility already exists in the shipped date-URL feature; the redirect just routes into it.
3. **Management surfacing:** **auto-by-capability** — an admin lands directly in full management (matches `/meetings/:id` today); the existing **Preview-as-member** toggle covers the reverse direction.
4. **Availability toggle for admins:** **shown** for every signed-in member including admins (an admin is also a participant; the availability server fns already accept any member). This removes a regression vs. today's pretty-URL-as-admin behavior. (Alternative "hide for admins to match `/meetings/:id`" was rejected.)
5. **Superadmin case — verified safe (no code needed):** `getAuthContext` pushes an active impersonation session into `myClubs` as an admin club and forces it active, so an impersonating superadmin gets `shell: true` on the pretty URL and `canManageClub` grants management through the `read_write` session (read-only → `shell` but `canManage: false`). A *bare* superadmin (not a member, not impersonating) has no management on `/meetings/:id` today either (`canManageClub` needs admin membership or a session), so the redirect strands them on an equivalent PII-safe read-only view.
6. **Container width:** adapts to capability — reading width for the member/anon agenda, wider `PageContainer` when `canManage`.

## Constraints & boundaries (must not break)

- **PII boundary:** the `shell ? getMeetingByKey : getPublicMeetingByKey` fork stays exactly as-is. Anonymous visitors always load via `getPublicMeetingByKey` (hard `canManage=false`, never ships roster/contact/minutes). Unification changes *rendering*, never the payload boundary. `public-meeting-contact.guard.test.ts` and `server-modules.guard.test.ts` must stay green.
- **Service worker path coupling (required task):** `public/sw.js` is hard-scoped to `url.pathname.startsWith("/meetings/")` for offline caching of the meeting view. Moving the authed view to the pretty URL breaks offline read + offline-minutes unless the SW matcher is extended to also match `/club/:slug/meeting/…` (keep `/meetings/` too — harmless, and the redirect page is cache-eligible). The IndexedDB minutes queue is keyed by meeting uuid, so the queue itself is unaffected; only navigation caching is path-coupled.
- **App-shell page title (required task):** `app-shell.tsx` derives the meeting title from `pathname.startsWith("/meetings")`. Add a title branch for `/club/…/meeting/` so the pretty meeting page keeps a proper shell header.

## Inbound links

`/meetings/:id` redirects, so nothing breaks. Repoint only the hot path that already has slug+key:

- **`/next`** (`_authed/next.tsx`): redirect straight to the pretty URL (`getNextMeeting` returns `clubSlug` + `urlKey`) — avoids a double redirect.
- **`me.tsx`, `member-role-picker`, `admin/meetings.new`, `MeetingLink`:** leave as-is; they ride the single redirect hop. Optional later cleanup: repoint once `listMyCommitments` carries slug+key.

## Testing

- **Unit — viewer branch table:** `editable` / locked-wrapping as a pure function (admin-past-open editable; member-past read-only; locked → read-only for all). Extract so it isn't buried in the component.
- **Unit — actions selection:** manager path carries `actorMemberId` + no `selfMemberId` and exposes the manager-only actions; member/anon path carries `selfMemberId`.
- **Redirect:** `/meetings/:id` resolves to `/club/:slug/meeting/:urlKey` (date-key form); unknown id → `notFound()`.
- **PII guard:** existing guard tests stay green; add a case asserting an anonymous `getPublicMeetingByKey` payload carries no minutes/roster/contact.
- **Manual QA (`/browse`):** the two URLs from the report — anon vs. signed-in-admin on the pretty URL; redirect from the old uuid; Preview-as-member; a locked/past meeting; nav strip paging stays on the pretty URL.
- **Offline QA (kill-server-then-reload — browse can't emulate offline):** load the pretty meeting URL online, stop the server, reload → page + minutes still render; queue an offline minutes edit and confirm it replays on reconnect.

## Out of scope

- No changes to `<MeetingAgenda>` internals, the slots / availability / minutes server fns, or the present/print routes.
- No consolidation of `getMeeting` vs `getMeetingByKey` (both stay).
- Repointing `me.tsx` / role-picker links (they ride the redirect; optional follow-up).
