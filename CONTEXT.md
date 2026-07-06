# CONTEXT.md — tm-scheduler

A mobile-first web app for scheduling Toastmasters club meetings. Members claim meeting
roles from their phone in one tap; a VP Education / admin creates meetings, which auto-
generate the roles to be filled. It replaces a shared spreadsheet, whose real failings were
no reminders, no at-a-glance "what's still open," and edit conflicts.

## Glossary

Use these exact terms in issues, ADRs, tests, and code. They map Toastmasters vocabulary to
the nouns in `src/db/schema.ts`.

- **Club** — a Toastmasters club (`clubs`). A person can belong to several (see ADR-0006).
- **Person** — a human (`people`), keyed by their Toastmasters Customer ID (`PN-…`, nullable;
  unique when present, with email as a fallback match key). Holds the facts that are the same
  across *every* club a person belongs to: name, contact, `original_join_date` (first-ever TM
  join), enrolled Pathways paths, and the optional link to their sign-in account (`user_id`).
  See ADR-0008 / #64.
- **Membership** — a Person's participation in one Club (`members`; one row per person per
  club). Holds the *per-club* facts: role (`club_role` — `admin`/`vpe`/`member`; only
  `admin`/`vpe` may create meetings), `joined_at` ("member of *this* club since"), office
  (see #63), and status. This roster row is what meeting roles are claimed against. See
  ADR-0008.
- **`club_memberships`** — legacy auth-only link (signed-in `user` ↔ club) that today still
  resolves `club_role` in the auth path; being absorbed into Membership (ADR-0008, follow-up
  to #64). Not the roster.
- **Officer position** — a Person's elected club job on a Membership (`members.officer_position`),
  drawn from the standard Toastmasters club officers: President, VP Education, VP Membership,
  VP Public Relations, Secretary, Treasurer, Sergeant at Arms, Immediate Past President.
  Structured enum replacing the old free-text `office`; in-app editing is authoritative (CSV
  import only fills empties). Distinct from `club_role` (permission) — though President / VP
  Education *default* a linked account to `admin`. One current office per membership for now;
  multiple concurrent offices + term history are a follow-up. See #63.
- **`club_role`** — the app **permission** on a Membership: `admin` (may create/edit meetings,
  manage roster/roles) or `member`. Bound to the sign-in account, enforceable independent of
  roster metadata; defaulted from Officer position but stored explicitly (ADR-0008). (`vpe`
  was a third value that behaved identically to `admin`; it collapses into `admin`.)
- **Meeting** — a single club session (`meetings`) with a date, theme, and word of the day.
- **Role definition** — a club's template for a fillable role (`role_definitions`), e.g.
  Toastmaster of the Day (TMOD), Speaker, Evaluator, Table Topics Master, General Evaluator
  (GE), Timer, Ah-Counter, Grammarian. Carries `default_count` and `sort_order`.
- **Role slot** — one concrete, claimable agenda row for a meeting (`role_slots`). Generated
  from role definitions when a meeting is created. THE source of truth and history — see
  ADR-0005. A slot is `open`, `claimed`, or `confirmed`.
- **Claim / release** — a member takes (`claimSlot`) or gives up (`releaseSlot`) a slot.
  Claiming a speaker slot captures a **Speech** (or leaves it TBA to attach later).
- **Speech** — a prepared speech a **Person** owns (`speeches`): title, optional introduction,
  Pathways path/project/level, and min/max minutes. Durable and independent of the schedule —
  a speaker slot *references* one via nullable `role_slots.speech_id` rather than embedding it,
  so reassigning or rescheduling a slot never destroys the speech. Person-owned and *club-less*
  (a delivery's club comes from the slot it's attached to). Replaces the old slot-bound
  `speaker_details`. Scheduling state (unscheduled / scheduled / delivered) is **derived** from
  slot linkage, not stored. See ADR-0009 / #79.
- **Pathways** — Toastmasters' education program. A **path** (e.g. *Presentation Mastery*) is
  enrolled and owned by a **Person**, independent of any club; a person may work several paths
  at once. When a path **level** is completed, the credit is attributed to *one* of the
  person's clubs — a per-completion choice, and the only club-scoped Pathways concept. A
  speaker's project belongs to a path.
- **Evaluator → speaker link** — an evaluator slot points at the speaker slot it evaluates
  via `role_slots.evaluates_slot_id` (self-reference).

## Scope

**MVP (built):** magic-link auth, schedule view, meeting detail with one-tap claim, speaker-
detail capture, `/me` commitments with release, admin meeting creation with slot generation,
seed data.

**Out of scope (schema must not block, but build no logic):** reminder/notification sending
(the `notifications` table exists, unused), swap matching, role-rotation fairness, Pathways
progress dashboards, multi-club switching UI, calendar export. These are the later phases.

## Invariants

- A slot moves to `claimed` only via a conditional update guarding against double-claims
  (ADR-0005). Never set `assigned_user_id` without that guard.
- Only an active member of a meeting's club may claim its slots; only the assignee or a
  club `admin`/`vpe` may release.
- A meeting's **agenda content** — meta (theme, Word of the Day, notes, location) and slot
  assignment / count — may be edited by a club `admin`/`vpe` **or** by the self-asserted
  member holding that meeting's Toastmaster (TMOD) slot. **Reschedule, cancel, and status
  stay `admin`/`vpe`-only.** TMOD self-serve editing is an interim self-assert measure pending
  real auth (ADR-0010).
- `src/server/*` touches `db`/`pg` and must never be imported by client components.

## Where decisions live

`docs/adr/` — read the ADR for an area before changing it. If a change contradicts an ADR,
say so explicitly rather than silently overriding.
