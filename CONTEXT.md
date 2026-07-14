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
- **Guest** — a club-scoped visitor (`guests`) who can be assigned to a role slot as an
  alternative to a member (real case: a visitor served as evaluator). A lightweight, durable
  identity (name + optional contact), **not** a Person and **not** a Membership: no login, no
  Pathways, no roster/officer presence, and NOT a `members` status. A slot references at most one
  assignee — a member (`assigned_member_id`) OR a guest (`assigned_guest_id`), never both
  (enforced in logic + a DB check constraint). Guests never appear in the member roster/picker;
  guest-held slots render the name with a subtle "· Guest" marker and count as filled. Admin-only
  to assign (not on the public/TMOD view). A guest also carries a pipeline `stage` and, once
  promoted, a `converted_membership_id` — see **Guest pipeline**. See ADR-0013 / #151.
- **Guest pipeline** — the VP-Membership funnel over the `guests` entity (ADR-0017 / #208):
  **capture → stage-tracked prospect list → convert-to-member**. A guest's **stage**
  (`guest_stage` enum) is `prospect → following_up → joined → lost`: new guests default
  `prospect`, `following_up`/`lost` are manual admin transitions, and `joined` is set **only**
  by convert-to-member (alongside `converted_membership_id`). Each guest's **visit count** and
  **first-visit date** are *derived* from `meeting_attendance` (never a stored counter). The
  admin pipeline view lives at `/admin/vp-membership`; the assign-guest picker excludes `joined`
  and `lost` guests (`stage in (prospect, following_up)`).
- **Guest book** — the public, no-auth capture front door (ADR-0017, absorbing #239):
  `/club/:clubId/guest-book`, escaping the member-identity shell. A visitor self-enters
  name + optional email/phone; the server **creates-or-finds** the guest (dedup by phone → email,
  club-scoped, phone normalized to digits) and records a `meeting_attendance` visit against the
  club's **current/nearest meeting** (today's, else the next scheduled; none ⇒ no attendance
  row). Reached via a **stable per-club QR** on the VP-Membership view (printable table-tent);
  the QR never needs regenerating because the route resolves the current meeting itself.
- **Convert-to-member** — the admin action that promotes a guest into a Membership (ADR-0017):
  dedup/link the Person (phone → email), create the club Membership (`clubRole: member`,
  `joinedAt` today) or reuse the person's existing one, re-point the guest's role-slot
  assignments to the new member, stamp the guest `stage: joined` + `converted_membership_id`
  (the guest row persists as history — its past attendance stays), and log `member_add`.
- **`club_memberships`** — legacy auth-only link (signed-in `user` ↔ club) that today still
  resolves `club_role` in the auth path; being absorbed into Membership (ADR-0008, follow-up
  to #64). Not the roster.
- **Officer position** — a Person's elected club job on a Membership, drawn from the standard
  Toastmasters club officers: President, VP Education, VP Membership, VP Public Relations,
  Secretary, Treasurer, Sergeant at Arms, Immediate Past President. A structured enum
  (`src/lib/officers.ts`) replacing the old free-text `office`; in-app editing is authoritative
  (CSV import only fills empties). Distinct from `club_role` (permission) — though President /
  VP Education *default* a linked account to `admin`. See #63.
- **Officer term** (`officer_terms`) — the source of truth for who holds which office (#100):
  one row per office a Membership holds, over a span (`term_start` … `term_end`). A Membership's
  **current office(s)** are DERIVED as its open terms (`term_end IS NULL`) — it may hold several
  concurrently (e.g. Secretary + Treasurer). Removing an office closes its term (sets `term_end`),
  retaining it as history (officer recognition / term reporting); rows are never deleted on
  removal. Replaced the single `members.officer_position` column. See #100.
- **`club_role`** — the app **permission** on a Membership: `admin` (may create/edit meetings,
  manage roster/roles) or `member`. Bound to the sign-in account, enforceable independent of
  roster metadata; defaulted from Officer position but stored explicitly (ADR-0008). (`vpe`
  was a third value that behaved identically to `admin`; it collapses into `admin`.)
- **Superadmin** — a **platform-level** capability (`user.is_superadmin`), ORTHOGONAL to `club_role`
  and layered on top of club membership (a superadmin still earns per-club admin rights the normal
  way). Provisioned, not self-serve: reconciled two-way from the `SUPERADMIN_EMAILS` env allowlist
  (case-insensitive) on every sign-in — adding an email grants on next sign-in, removing it revokes;
  unset ⇒ nobody (fail closed). Enforced by `requireSuperadmin` (a separate guard — it does NOT
  bypass `requireClubRole`; no ambient cross-club access). Surfaced by `getAuthContext.isSuperadmin`.
  See ADR-0016 / #183. (Console UI #182, impersonation #185.)
- **Provisioned onboarding** — a new club is created only by a **superadmin** through the
  console (`/superadmin`, #182), never self-serve: one atomic transaction writes the club (unique
  number + derived slug) + the 8 standard role definitions + a first admin (a Person with
  `user_id` NULL and an `admin` Membership); the admin's account links on their first sign-in
  (#188), and their email is editable in the console only while still unclaimed. See ADR-0016.
- **Meeting** — a single club session (`meetings`) with a date, theme, and word of the day.
  Its `status` follows a lifecycle: `scheduled → completed` (admin **Complete**, only on/after
  the meeting date) and `completed → scheduled` (admin **Reopen**, any time). A **completed**
  meeting is **locked** — read-only, every agenda mutation is rejected server-side and shows a
  "This meeting is locked." banner. Speech-delivered stays date-derived (ADR-0009). See ADR-0012.
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
- **Minutes** — the post-meeting *record of what actually happened*, distinct from the agenda
  (the plan). Not its own table: the `meetings` row is the header, and the record is the three
  child sets below (attendance, Table Topics speakers, awards). Admin-authored on the meeting
  view; members see it read-only, and only once the meeting is `completed`. Editable through and
  after completion — **not** covered by the ADR-0012 lock. Exportable as a PDF. See ADR-0014 / #152.
- **Attendance / Presence** — per-meeting record of who was there (`meeting_attendance`). Each
  active **member** carries a presence status — `present` / `absent` / `excused` (default
  `absent`), pre-filled to `present` for anyone holding a role slot. **Guests** present are added
  to the same record (present by definition — no absent/excused). Rows reference a member **or** a
  guest, never both (XOR check constraint, like `role_slots`). See ADR-0014.
- **Table Topics speaker** — an impromptu participant who answered a Table Topic
  (`table_topics_speakers`), captured as an ordered list of member-or-guest (XOR) + optional
  topic text. Distinct from the **Table Topics Master** role (the role definition that runs the
  segment). See ADR-0014.
- **Award** — a meeting's ribbon winner (`meeting_awards`): Best Speaker, Best Evaluator, or Best
  Table Topics, each an optional member-or-guest (XOR). See ADR-0014.
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
- A **completed** meeting is **locked**: every agenda mutation (assign/claim/takeover,
  confirm/unconfirm, move/add/remove role/speaker, availability toggle, meta edit) is rejected
  server-side, regardless of surface or capability. Only an admin **Reopen** (→ `scheduled`)
  lifts the lock. Enforced at `resolveMeetingAgendaAuthz` / `assertMeetingNotLocked`, not the UI
  (ADR-0012).
- `src/server/*` touches `db`/`pg` and must never be imported by client components.

## Where decisions live

`docs/adr/` — read the ADR for an area before changing it. If a change contradicts an ADR,
say so explicitly rather than silently overriding.
