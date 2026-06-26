# CONTEXT.md — tm-scheduler

A mobile-first web app for scheduling Toastmasters club meetings. Members claim meeting
roles from their phone in one tap; a VP Education / admin creates meetings, which auto-
generate the roles to be filled. It replaces a shared spreadsheet, whose real failings were
no reminders, no at-a-glance "what's still open," and edit conflicts.

## Glossary

Use these exact terms in issues, ADRs, tests, and code. They map Toastmasters vocabulary to
the nouns in `src/db/schema.ts`.

- **Club** — a Toastmasters club (`clubs`). A user can belong to several (see ADR-0006).
- **Membership** — a user's link to a club with a role (`club_memberships`); `club_role` is
  one of `admin`, `vpe`, `member`. Only `admin`/`vpe` may create meetings.
- **Meeting** — a single club session (`meetings`) with a date, theme, and word of the day.
- **Role definition** — a club's template for a fillable role (`role_definitions`), e.g.
  Toastmaster of the Day (TMOD), Speaker, Evaluator, Table Topics Master, General Evaluator
  (GE), Timer, Ah-Counter, Grammarian. Carries `default_count` and `sort_order`.
- **Role slot** — one concrete, claimable agenda row for a meeting (`role_slots`). Generated
  from role definitions when a meeting is created. THE source of truth and history — see
  ADR-0005. A slot is `open`, `claimed`, or `confirmed`.
- **Claim / release** — a member takes (`claimSlot`) or gives up (`releaseSlot`) a slot.
  Speaker slots require speaker details to claim.
- **Speaker details** — title, Pathways path/project, and min/max minutes for a speaker slot
  (`speaker_details`, 1:1 with the slot).
- **Pathways** — Toastmasters' education program; a speaker's project belongs to a path.
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
- `src/server/*` touches `db`/`pg` and must never be imported by client components.

## Where decisions live

`docs/adr/` — read the ADR for an area before changing it. If a change contradicts an ADR,
say so explicitly rather than silently overriding.
