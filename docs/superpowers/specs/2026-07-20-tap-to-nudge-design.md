# VPE tap-to-nudge — design (#37)

**Status:** approved (brainstormed + grilled 2026-07-20)
**Issue:** #37 (scoped to the residual: tap-to-nudge; per-role deep-link deferred)
**Builds on:** the shipped public per-meeting page (`club.$clubId.meeting.$meetingId.tsx`) and copy-link button (PR #50).

## Problem

The public per-meeting page and a copy-link affordance already exist. What's missing is the fast path for a VPE / Toastmaster-of-the-Day to reach a member **personally**: one tap that opens their own WhatsApp or email, pre-drafted with the member's name, their role, the date, and the shareable link — which they then edit and send themselves.

This is deliberately **not** automation. Automated role reminders already exist (#272/#281, scheduled email — the safety net). Tap-to-nudge is the human-driven complement: the app *composes a draft*; the human *sends it*. Nothing leaves without the VPE pressing send. It also adds WhatsApp, a channel the automated path doesn't cover.

## Scope

**In:**
- **Confirm nudge** on filled slots — remind the holder they're on.
- **Recruit nudge** on open slots — ask a chosen member to take it.
- Two channels: WhatsApp (`wa.me`) and email (`mailto:`), shown by what contact the target has.

**Out:**
- Per-role public deep-link page (issue marks optional; the per-meeting page exists).
- Any auto-send. The app only ever drafts.
- Activity-log / outreach tracking (see Q5).
- Phone-number normalization (see the follow-up ticket).

## The PII boundary

The nudge is composed in the **authed** meeting view, which is gated to `canManage` (VPE/President resolve to club `admin`). `wa.me`/`mailto:` are URL schemes opened client-side; contact never rides the public payload.

- The `canManage`-gated `roster` in `getMeeting` is extended from `{id,name}` to `{id,name,phone,email}` — mirroring the established `includeContact` PII pattern (`loadSeasonGrid`).
- Filled-slot holder contact is resolved from **`members.*`** (member holder) or **`guests.*`** (guest holder) on the same gated payload.
- **The public `/club/:clubId/meeting/:id` payload is untouched** — still no contact. Enforced by a guard test asserting the non-`canManage` path returns no phone/email.

## Components

### `#/lib/nudge.ts` — the compose primitive (pure, no `#/db`)

```
buildNudge({
  name: string,
  phone?: string | null,
  email?: string | null,
  roleName: string,
  meetingDate: string,   // already formatted friendly, club tz (footerDate)
  shareUrl: string,      // absolute; caller prepends window.location.origin
  mode: "confirm" | "recruit",
}) => {
  message: string,
  whatsappUrl?: string,  // omitted when no phone
  mailtoUrl?: string,    // omitted when no email
}
```

- **Phone → `wa.me`:** strip to digits (drops `+`, spaces, dashes). Best-effort — a number stored without a country code yields a link WhatsApp rejects *visibly* ("number invalid"); the VPE falls back to Email/copy. A one-line UI hint states WhatsApp needs the number saved with a country code. (Robust fix = the phone-normalization follow-up.)
- **Message templates** (VPE edits before sending; role always named because the link is per-meeting):
  - confirm: `Hi {name}, just confirming you're our {role} for the {date} meeting. Details: {url}`
  - recruit: `Hi {name}, would you be open to taking {role} at our {date} meeting? Info here: {url}`
- **Email subject:** confirm `Confirming your {role} role — {date}`; recruit `Open {role} role — {date} meeting?`. Body = the message line.
- No signature (opens from the VPE's own account). No club name in the body (the linked page carries club context).
- `encodeURIComponent` on `?text=` / mailto body.

Lives in `#/lib` like `dcp.ts` so it stays client-safe and unit-testable.

### `NudgeButtons` (client component)

WhatsApp + Email affordances rendered from a `buildNudge` result. Shows only the channels present; when neither, renders a muted "No contact on file". Links are plain anchors: `wa.me` via `<a target="_blank" rel="noopener">`, email via `<a href="mailto:…">`. Computes the absolute share URL (`window.location.origin + /club/{clubSlug}/meeting/{id}`) itself, like `ShareLinkButton`.

### Filled-slot nudge (in `_authed/meetings.$id.tsx`)

On each held slot row, when `canManage`, render `NudgeButtons` in `"confirm"` mode for the holder (member or guest). Holder contact comes from the gated payload.

### Open-slot recruit (in `_authed/meetings.$id.tsx`)

On each open slot, when `canManage`, a "Nudge someone" trigger opens a **searchable** picker (`cmdk` Command, reusing the `member-role-picker` popover pattern) over the active-member `roster`. Each member is **annotated, never filtered**:
- "Not available" when a `member_availability` row exists for this meeting,
- "Already: {role}" when they hold another slot in this meeting,
- "no contact" when they have neither phone nor email.
Selecting a member reveals that member's `NudgeButtons` in `"recruit"` mode (or the no-contact state). Everyone stays selectable — the VPE decides whom to ask; the flags only inform. No positive "available" state (it doesn't exist in the data).

## Testing

- **Unit (`nudge.test.ts`):** phone→digits sanitization (with `+`, spaces, dashes; country-code-present vs absent), channel omission when a contact is missing, both message templates + subjects, URL encoding of names with apostrophes/spaces.
- **PII guard (integration):** `getMeeting` on the **non-`canManage`** path returns a `roster`/holder payload with **no** phone/email.
- **Integration:** the `canManage` path *does* expose contact for member holders, guest holders, and roster members.
- The `cmdk` `onSelect` interaction is not headless-clickable (known repo gotcha); the picker's selection→compose path is covered by the unit/integration layer rather than a headless browse click.

## Gates

`bun run typecheck`, `bun run check`, `bun run test` (with `TEST_DATABASE_URL`) all pass. `#/lib/nudge.ts` must not import `#/db`.

## Follow-ups (separate tickets)

1. **Phone normalization** — a club default country code (prepended to numbers lacking one) **and** standardizing phone inputs to store a leading `+` (E.164), so `wa.me` stripping is deterministic. Makes the WhatsApp channel reliable rather than best-effort.
2. Per-role public deep-link page (optional stretch from #37).
3. (Maybe) an explicit "mark as contacted" action, if outreach-tracking proves needed — the honest version of the logging we deliberately skipped.
