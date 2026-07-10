# ADR-0013: Guests as club-scoped, role-assignable non-members

Status: Accepted

## Context

A visitor sometimes fills a role at a meeting — the motivating case (#151): a guest served as
the club's **evaluator**. Today a role slot can only be held by a roster member
(`role_slots.assigned_member_id → members.id`), so there was no way to put a non-member on the
agenda.

A guest must **not** be modeled as a `members` row with a new `status`. Member status filtering
is scattered and inconsistent across queries (some `eq(status,"active")`, some
`ne(status,"inactive")`), so a "guest" status would leak into some roster/season/picker views
and vanish from others. A guest is also not a Person (ADR-0008): no login, no Pathways, no
officer terms.

## Decision

Introduce a **dedicated, club-scoped `guests` entity** that a role slot can reference as an
alternative to a member.

- **`guests` table:** `id`, `club_id` (cascade), `name` (required), optional `email`/`phone`,
  timestamps. One durable row per guest per club — it reappears as an assignable option in
  later meetings.
- **`role_slots.assigned_guest_id`** (nullable, `→ guests.id`, `on delete set null`),
  **mutually exclusive** with `assigned_member_id`. The "at most one assignee" invariant is
  enforced two ways: in the assignment logic (assigning a guest clears the member, and every
  member-assign path clears the guest) **and** a DB check constraint
  `assigned_member_id IS NULL OR assigned_guest_id IS NULL`.
- **Assignment is admin-only.** The `assignGuestSlot` server fn gates on the club `admin` role
  (`requireClubRole`), *not* the softer meeting-agenda-editor path — so it is **not** offered on
  the public self-serve/TMOD meeting view. An admin either creates a new club guest (name +
  optional contact) or picks an existing one, from the existing assign-slot sheet.
- **Name resolution everywhere.** Every read path that resolves a slot's assignee — the
  meeting/agenda loader, `buildSlideDeck` present deck, the print agenda, and the season grid —
  resolves `assigned_guest_id → guests.name` and surfaces an `assigneeIsGuest` flag so the UI
  renders a subtle **"Guest" marker** (e.g. `Ben Carter · Guest`). Guest-held slots count as
  filled/confirmed in `summarizeAgenda`, exactly like a member-held slot.
- **Guests are a distinct list.** They never appear in the member roster or the member picker.
- **Speeches stay Person-owned (ADR-0009).** A guest may hold a speaker slot, but no
  Person-owned Speech is attached — assigning a guest unlinks any existing speech (which
  persists) and the slot simply shows the guest's name. Unassigning a guest reopens the slot and
  preserves the guest row for reuse.

## Consequences

- Guests sit adjacent to Person/Membership (ADR-0008) as a third, lightweight identity: durable
  and club-scoped, but with no auth, Pathways, or roster/officer presence.
- **Promotion-to-member is anticipated but not built here.** Because a guest is a durable row
  with a stable id that slots reference, a later pipeline can create `people`/`members` rows from
  a guest and re-point that guest's slot assignments to the new member.
- Out of scope (separate future issues): a guest attendance list for non-role guests, Table
  Topics participation recording, public self-serve guest assignment, guest Pathways speeches,
  and any `members` guest status.
