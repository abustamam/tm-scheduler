# ADR-0018: Guest pipeline — capture, lifecycle stages, and convert-to-member

Status: Accepted

Extends ADR-0013 (guests as club-scoped, role-assignable non-members) and builds on
ADR-0008 (Person vs Membership). Absorbs #239 (public guest-book + QR). See #208.

## Context

ADR-0013 introduced the durable, club-scoped `guests` entity and explicitly anticipated a
follow-on: *"a later pipeline can create people/members rows from a guest and re-point that
guest's slot assignments to the new member."* Until now a guest row only existed as a side
effect of an admin assigning a visitor to a role slot — there was no way to **capture** a
walk-in visitor, no **lifecycle** to track them across meetings, and no **promotion** path to
turn a returning prospect into a member. That funnel is exactly the VP Membership's job.

`meeting_attendance` already carries a nullable `guest_id` (ADR-0014), so a guest's *visits*
are already recordable; what was missing was a front door to write them and a stage model to
act on them.

## Decision

Turn `guests` into a VP-Membership pipeline with three parts — **capture → stage-tracked
prospect list → convert-to-member** — adding the minimum durable state.

- **Two columns on `guests`** (localized, additive migration):
  - **`stage`** — a `guest_stage` enum `prospect → following_up → joined → lost`. New guests
    default `prospect`. `following_up`/`lost` are manual admin transitions; **`joined` is set
    only by convert-to-member** (never a bare stage change), so it always travels with the
    membership pointer.
  - **`converted_membership_id`** — nullable FK → `members.id`, `on delete set null`. Set once,
    on conversion. The guest row is **never deleted**: it persists at `stage: joined` as
    durable history (its past attendance/slot facts stay intact); if the membership is later
    removed the pointer clears but the history remains.

- **Public guest-book capture (the #239 front door).** A no-auth, club-scoped route
  (`/club/:clubId/guest-book`, escaping the member-identity shell) collects `name` (required) +
  optional `email`/`phone` — mirroring the `guests` columns, nothing more. On submit a public
  server fn **creates-or-finds** the guest and records a visit:
  - **Dedup key is phone** (normalized to digits so `(555) 123-4567` and `555-123-4567` match),
    then **email** (case-insensitive), both club-scoped. A match reuses the existing guest
    (filling in any newly-supplied missing contact); no match creates a new guest at
    `prospect`.
  - It resolves the club's **current/nearest meeting** — a non-cancelled meeting scheduled for
    *today* in the club's timezone (the guest is at it now), else the next upcoming scheduled
    meeting — and writes a `meeting_attendance` row (`guest_id`, `status: present`). A repeat
    scan at the *same* meeting is idempotent (the meeting×guest unique index); a returning guest
    at a *later* meeting gets a new attendance row. If **no meeting is resolvable**, the guest is
    still created with no attendance row.
  - The route is **always open** (no admin enable/disable toggle).

- **Stable per-club QR.** The VP-Membership view renders a QR encoding the absolute guest-book
  URL (plus the URL as text and a print/table-tent affordance). The QR is **stable** — the
  route resolves the current meeting itself, so it never needs per-meeting regeneration. A new
  client-side QR library (`qrcode.react`) renders it as SVG (scales for print).

- **Pipeline view (admin-only).** `/admin/vp-membership` groups guests by stage with manual
  transitions for `prospect`/`following_up`/`lost`. Each guest shows a **derived** first-visit
  date and visit count computed from `meeting_attendance` joined to `meetings` — **never a
  stored counter** (the derived style of `role-recency-logic.ts`).

- **Convert-to-member.** An admin-gated server fn, transactional:
  1. **Dedup the Person** (phone → email; People are club-less, ADR-0008): link an existing
     Person if found, else create one.
  2. **Create the Membership** for this club (`clubRole: member`, `joinedAt: today`, carrying
     `name/email/phone`) — or reuse the person's existing membership in this club, so we never
     violate one-membership-per-person-per-club.
  3. **Re-point every `role_slots.assigned_guest_id`** for that guest to the new
     `assigned_member_id` (setting the member and clearing the guest in one update keeps the
     member-XOR-guest check constraint satisfied).
  4. **Stamp the guest** `stage: joined` + `converted_membership_id`.
  5. **Write an `activity_log`** entry (`member_add`, with `fromGuestId`).

- **Picker exclusion.** The ADR-0013 assign-guest picker (`listClubGuests`) now filters to
  `stage in (prospect, following_up)` — a `joined` guest is a member (assigned as a member),
  and a `lost` guest is off the table. After conversion the guest no longer appears in the
  picker but remains visible in the pipeline under `joined`.

## Consequences

- The guest becomes the VP Membership's CRM object without becoming a Person or a member until
  the moment of conversion — the ADR-0013 boundary (a guest is *not* a Person/Membership) holds
  right up to the explicit convert action, which crosses it deliberately and traceably.
- Visits stay **derived** from attendance, so there is no counter to drift; a guest's history
  survives conversion because the row is kept, not migrated.
- **Deferred (out of scope here):** automated follow-up reminders / VPM nudges (depend on the
  reminder poller #7); a follow-up contact-log table or per-guest notes (only the current
  `stage`); an admin merge/dedup UI for name-only collisions (phone/email dedup only); member
  retention/renewal (that is dues territory, #206). This ticket is guest → member only.
