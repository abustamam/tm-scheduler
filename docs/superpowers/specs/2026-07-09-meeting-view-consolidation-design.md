# Consolidate the signed-in meeting screens into one shared component

**Issue:** #141. Follow-on (deferred): #145 (fold in the public self-asserted view).
**Date:** 2026-07-09
**Scope:** Merge the two **signed-in** meeting screens — `/agenda` and `/meetings/$id` — into one shared `<MeetingAgenda>` component so they offer a consistent capability set for the same data. Does **not** touch the public club view (`club.$clubId.meeting.$meetingId.tsx`) — that's #145.

## Problem

There are two signed-in single-meeting screens that expose **different capabilities for the same data**:

| Screen | File | Loader | Manage (assign/confirm/move) | Sign up | Stats header | Print/Present/Nav |
|---|---|---|---|---|---|---|
| `/agenda` (next meeting) | `src/routes/_authed/agenda.tsx` | `getNextMeeting` | ❌ | ✅ | ✅ (theme card, stat tiles, roles-filled %) | Print + Present (no nav) |
| `/meetings/$id` (by id) | `src/routes/_authed/meetings.$id.tsx` | `getMeeting` | ✅ | ✅ | ❌ | Print + Present + nav |

They also **triple-duplicate** UI: a near-identical `ClaimSpeakerSheet` is defined in `agenda.tsx`, `meetings.$id.tsx`, *and* the public `club.$clubId.meeting.$meetingId.tsx`; the category/slot-row rendering is copied too.

## Key facts that make this tractable

- **Both signed-in screens already share the loader and the identity model.** `getNextMeeting` returns `loadMeetingDetail(next.id, currentUser.id)` — the *same* rich shape `getMeeting` returns (`meeting, slots, canManage, timezone, roster, unavailableMembers, clubSlug`). Both components read `currentMemberId` / (implicitly) `canManage` from the `_authed` route context. So `/agenda` already *has* all the data to render the full management view — it just doesn't.
- This is why consolidation here is not the identity-model reconciliation that #145 is: the two signed-in screens are already the same model. #145 is the hard one (self-asserted `isTmod` vs session `canManage`).

## Approach

Extract one shared `<MeetingAgenda>` component that owns all rendering + interaction for a signed-in meeting. Both routes become thin (loader + empty-state only) and render it. This is the "share one component" the issue calls for and collapses the duplicated sheets/rendering into one place.

## Design

### 1. Shared component `src/components/club/meeting-agenda.tsx`

Props are the union both routes already have:
```
meeting, slots, canManage, currentMemberId, timezone,
roster, unavailableMembers, clubSlug, navItems
```
Renders the **superset** of today's two screens, in this order:

1. **Header:** title/theme; date · time · location; Word of the day; `MeetingNavStrip` (with the authed `getLinkProps` targeting `/meetings/$id`); `MeetingViewActions` (Print/Present); Copy-member-link; Edit-meeting button (canManage).
2. **Stats strip** (the chosen layout — kept from `/agenda`): a compact tile row + progress bar derived from `summarizeAgenda(slots)` — open roles, confirmed count, prepared-speeches count, and the roles-filled % progress bar. (Theme and Word of the day are already in the header above, so they are not repeated here.) Preserve the existing `canManage` "Remind unfilled" stub button (non-functional today; hints at #7 — out of scope to wire up).
3. **Unavailable-members section** (from `/meetings/$id`).
4. **Category sections + slot rows** with the full action set: claim / release; assign / reassign (canManage); confirm / unconfirm (canManage); move-speaker up/down (canManage); edit-speech; add / remove speaker (canManage).
5. **Sheets/dialogs** composed from focused sibling files (below).

When `canManage` is false (a regular signed-in member), the manage-only actions simply don't render — the same component yields a member's view (claim/release/sign-up + stats + print/present/nav).

### 2. Extract the sheets/dialogs into focused files

`meeting-agenda.tsx` composes these rather than inlining them (keeps each file focused):
- **Create `src/components/club/claim-speaker-sheet.tsx`** — the signed-in speaker-claim sheet (title required), replacing the two copies currently in `agenda.tsx` and `meetings.$id.tsx`. Use `side="right"` (desktop workspace convention). *(The public view keeps its own variant until #145.)*
- **Create `src/components/club/edit-meeting-dialog.tsx`** — the signed-in Edit-meeting dialog (date/time, length, theme, location, WoD, notes) currently inline in `meetings.$id.tsx`.
- **Reuse existing** `AssignSlotSheet` and `EditSpeechSheet` components as-is.

### 3. Routes become thin

- `src/routes/_authed/meetings.$id.tsx`: loader unchanged (`getMeeting` + `deriveMeetingNavItems`). Component: read `currentMemberId` from context, render `<MeetingAgenda {...loaderData} currentMemberId={currentMemberId} />`.
- `src/routes/_authed/agenda.tsx`: loader resolves the next meeting (`getNextMeeting`) and, when a meeting exists, additionally fetches `listUpcomingMeetings` + builds `navItems` via `deriveMeetingNavItems` (so `/agenda` gains the nav strip). Component: render the existing empty state when `meeting` is null; otherwise `<MeetingAgenda …>`. The nav strip's `getLinkProps` targets `/meetings/$id` (paging drills into the by-id view).

### 4. Testable seam

Extract the at-a-glance stats into a pure function in `src/lib/agenda.ts`:
```
summarizeAgenda(slots) => {
  total, filled, open, pct, confirmed, speakerTotal, speakerFilled
}
```
Unit-test it in `src/lib/agenda.test.ts` (counts, percentage rounding, empty-slots → 0%). Everything else in `<MeetingAgenda>` is interaction, verified live via `/browse`; the slot server-fns already have integration coverage for the write paths.

## Scope boundaries (non-goals)

- **No public view.** `club.$clubId.meeting.$meetingId.tsx` is untouched — folding it in (and reconciling the self-asserted vs session identity models, availability/takeover vs confirm/move-speaker) is **#145**.
- **No identity-model changes**; `currentMemberId` / `canManage` continue to come from the `_authed` context and `loadMeetingDetail`.
- **No multi-club change**: `/agenda` still shows `context.clubs[0]`'s next meeting (that seam stays #10).
- **No reminders wiring** (the "Remind unfilled" button stays a stub — #7).

## Error / edge handling

- `/agenda` with no upcoming meeting → route renders the existing empty state; `<MeetingAgenda>` is not mounted (so it can assume a non-null meeting).
- `listUpcomingMeetings` in the `/agenda` loader is non-fatal (`.catch(() => [])`), mirroring the by-id loader — a failure degrades to no strip.
- `roster` is only populated by `loadMeetingDetail` when `canManage`; the assign sheet is only shown when `canManage`, so the two are consistent.
- `MeetingNavStrip` already returns null for ≤1 meeting.

## Files touched

- `src/components/club/meeting-agenda.tsx` (new — the shared view)
- `src/components/club/claim-speaker-sheet.tsx` (new — extracted, shared by the routes via the component)
- `src/components/club/edit-meeting-dialog.tsx` (new — extracted from `meetings.$id.tsx`)
- `src/routes/_authed/meetings.$id.tsx` (thin: loader + render `<MeetingAgenda>`)
- `src/routes/_authed/agenda.tsx` (thin: empty state + loader builds navItems + render `<MeetingAgenda>`)
- `src/lib/agenda.ts` (add `summarizeAgenda`)
- `src/lib/agenda.test.ts` (add `summarizeAgenda` tests)

## Risk

Meaty refactor merging two ~500-line files into one component + two thin routes; regression risk on claim/assign/confirm/release/move flows. Mitigations: keep behavior per-capability identical to today; lean on existing slot server-fn integration tests; verify all flows live via `/browse` before landing. Land as a focused branch/PR.
