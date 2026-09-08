# District license — design

**Issue:** none yet. `/spec` exits this into three `ready-for-agent` issues, A, B and C (D7).
**Depends on:** ADR-0016 (provisioned onboarding), ADR-0024 (trademark-safe default), ADR-0025 (no Base Camp sync in the commercial product), #686 (officer training records behind DCP goal 9), #62 (membership CSV upload)
**Status:** approved by the maintainer 2026-09-08. Ready for `/spec`.

Brainstormed 2026-09-08. Eight decisions, D1–D8. The commercial side (who buys, at what price, on what calendar) lives outside this repo on purpose; this document is the product.

---

## Problem

GavelUp is multi-club by construction (ADR-0006) but single-operator in practice: one maintainer runs it for their own clubs, and every surface was built for that operator's needs before anyone else's. Two consequences matter now.

1. **Nothing above the club exists.** `clubs.district` is a display label — `src/db/schema.ts:262-264`, "district: display label only (e.g. "District 39")" — read by the agenda slides and the meeting header and nothing else. There is no area, no division, no district officer, and no way for anyone outside a club to see how it is doing.
2. **An officer who is not the maintainer cannot get from an empty club to a running meeting unaided.** Onboarding is superadmin-provisioned by design (ADR-0016) and stays that way (D5). What is missing is the stretch after provisioning — recurrence, template, first meetings, roster, sign-ins — which today lives in the maintainer's head.

The direction chosen 2026-09-08: **the district is the customer; clubs are the users.** A district buys one license, its clubs get GavelUp free, and the district's officers get what Toastmasters' own tooling does not give them: a between-visits view of club health. One buyer instead of thirty, and distribution through the district's own channels (officer training, Area Director visits) instead of club-by-club sales.

What that requires of the product is the three specs below. What it does not require is billing (D6) or self-serve signup (D5).

## What ships

Three specs, ordered (D7):

- **A — an officer's first month.** A guided first-meeting checklist on the dashboard and a UX pass on the five screens a club officer touches most, driven by a fresh-officer `/qa` run and one real pilot officer.
- **B — the district layer.** Districts, areas, district officer terms, read-only scope resolution, and the per-club sharing switch.
- **C — the district dashboard.** Club-health rows, the needs-a-visit rule, and a weekly Area Director digest.

## What does not ship

- Self-serve club signup. Provisioning stays superadmin-only (ADR-0016).
- Billing of any kind. A district license is an agreement and an invoice (D6).
- Any TI mark (ADR-0024). "District", "Area", "Division" and the officer titles are nominative.
- Member PII, dues, or anything per-member to district officers (D4).
- District officers editing club data (D2).
- Automated Base Camp access (ADR-0025).
- The public agenda-generator page. Separate, small spec.
- An ADR recording the commercial direction. Written after this design lands, as ADR-0026, in the ADR-0024/0025 series.

## Already done — do not rebuild

| Capability | Where | Note |
|---|---|---|
| Membership CSV import from the Club Central export, Customer-ID resolution, read-only preview | `src/lib/members-import-plan.ts`, `src/server/upload-members-logic.ts`, `src/server/import-members-logic.ts` (#62) | A links to it from the checklist; it does not touch it |
| Multi-club, Person vs Membership | ADR-0006, ADR-0008 | A person already spans clubs; a district officer is a person, not a membership |
| Club officer terms and effective-admin | `officer_position` enum `src/db/schema.ts:72`, `src/server/officers-logic.ts` | D2 mirrors the shape one level up |
| DCP scoreboard, goal 9 officer training records | ADR-0019, #686, `officer_training_periods`, `officer_training_records` | C reads these; it does not derive goals |
| Notifications and the in-process poller | ADR-0023 | C's digest is a new notification type on the same poller |
| Superadmin console, read-only impersonation | ADR-0016, ADR-0020, `src/routes/_authed/superadmin/*` | B adds an area picker to club creation |
| Public resources pages | `src/routes/resources.*` | Untouched |

## Decisions

### D1 — District is an entity; area carries its division letter; no divisions table

`districts(id, number int unique, name text, slug text unique)` and `areas(id, district_id fk cascade, division char(1), number int, unique(district_id, division, number))`. `clubs.area_id` nullable fk, `on delete set null`. `clubs.district` text stays as the display fallback; when `area_id` is set the header derives "District N" from the join and the text column is ignored.

Why no divisions table: a division has a letter, a director and nothing else; the letter on the area is enough to scope a Division Director (D2). Adding the table is one migration later if a division ever grows data of its own.

### D2 — District officers are terms on a person, scoped by position, read-only

`district_position` enum: `district_director`, `program_quality_director`, `club_growth_director`, `division_director`, `area_director`. `district_officer_terms(id, person_id fk, district_id fk, position, division char(1) null, area_id fk null, starts_on, ends_on)`, with check constraints: `division_director` requires `division`, `area_director` requires `area_id`, the other three require neither.

Scope: the trio sees every club with an area in the district; a Division Director every club whose area carries their letter; an Area Director their area. One function, `districtScopeForPerson(personId) → Set<clubId>`, in a new `src/server/district-officers-logic.ts`, is the only place scope is computed.

Read-only: no write server function accepts district scope as authorisation. The dashboard (C) is the only surface that reads it. A district officer who is also a club member keeps their club permissions unchanged; the two never merge.

Terms are entered by the superadmin (ADR-0016 shape). Self-declared district office is out of scope.

### D3 — The dashboard is one row per club, with definitions that are measured, not judged

Per club, over windows that are named constants:

| Column | Definition |
|---|---|
| Last meeting | `max(meetings.scheduled_at)` with status not cancelled and `scheduled_at <= now()` |
| Role fill | filled `role_slots` ÷ total `role_slots` across the last 4 non-cancelled meetings |
| Attendance trend | present count at the last meeting vs the mean of the prior 3, as a signed delta |
| Guests | guests created in the last 60 days, and how many converted |
| DCP | goals marked achieved ÷ 10 from `dcp_goal_progress` for the current program year |
| Officer training | trained positions ÷ 7 in the current `officer_training_periods` row |

**Needs a visit** (v1 rule, constants in one place): no non-cancelled meeting in 21 days, **or** role fill under 60%, **or** attendance down at each of the last two meetings. The flag says which rule fired.

**Weekly digest**: Monday, one email per Area Director, their area's rows plus the flagged clubs. A new notification `type` drained by the ADR-0023 poller. Opt-out per officer, not opt-in, because an Area Director who never sees it never asks for it.

Thresholds are the first thing the pilot will tune; they ship as constants with the rule names, not as UI.

### D4 — Clubs opt in; district officers see aggregates only

`clubs.share_health_with_district boolean not null default false`. Superadmin club creation sets it `true` when an area is chosen (a club provisioned under a district license); the club-settings page shows the switch with plain copy naming the district and what is shared. When `false`, the club's row on the dashboard shows its name and "not sharing" and nothing else.

Nothing in D3 names a member. No emails, no names, no dues, no per-member attendance leaves the club. This is the boundary the product is sold on, and the reason district officers never get PII exposure through GavelUp.

### D5 — Onboarding stays provisioned; the first month is guided

No public create-club route. Superadmin creates the club, picks its area (B), and the president and VP Education sign in by magic link (existing). The dashboard then shows a checklist derived from data, not stored state:

1. Meeting recurrence set (`club_meeting_recurrence` row exists)
2. Agenda template chosen (a club-level template exists, #622)
3. Next meetings generated (≥ 1 future non-cancelled meeting)
4. Members imported (≥ 5 active memberships) — links to the #62 upload
5. Members signing in (≥ 1 member who is not an officer has a linked user)

Each item links to the screen that completes it. It disappears when all five are true and can be dismissed earlier by an admin. Derived, so it is always honest and never needs a migration.

The UX pass in A covers, in this order, the five screens an officer touches in that first month: dashboard, `admin/schedule`, `admin/roles`, `roster`, `meetings.$id`. The `/qa` run uses a fresh-officer persona with no prior knowledge of the app; findings become the A issue's checklist, not separate issues (CLAUDE.md, "What earns an issue").

### D6 — No billing code

A district license is a one-page agreement and an invoice outside the app. Stripe, plans, and per-club Pro are a later design and get their own ADR when they come. Nothing in A, B or C references a plan, a tier or a price.

### D7 — Three specs, this order, file-disjoint where possible

| Spec | Touches (for `/spec` Phase 3 to confirm) | Depends on |
|---|---|---|
| A | `src/routes/_authed/dashboard.tsx`, `admin/schedule.tsx`, `admin/roles.tsx`, `roster.tsx`, `meetings.$id.tsx`, a new onboarding-checklist component and its `-logic` module | nothing |
| B | `src/db/schema.ts`, a drizzle migration, `src/server/clubs-logic.ts`, new `src/server/district-officers-logic.ts`, `src/routes/_authed/superadmin/*`, `admin/club-settings.tsx` | nothing |
| C | new `src/routes/_authed/district/*`, new `src/server/district-health-logic.ts`, a new notification type in the poller | B |

A and B are disjoint and can ride one wave. C follows B. A ships first because pilot clubs have to run meetings before C has anything to show.

### D8 — Out of scope, named so nobody rebuilds it

The agenda-generator page, the ADR, billing, self-serve signup, TI marks, PII to district officers, district officers writing club data, and Base Camp automation. Each is listed under "What does not ship" above with its reason.

## Open questions for `/spec`

- Whether `districts.number` is enough identity or whether TI's region matters for anything. Assume not.
- Whether the weekly digest goes to the trio as well, or to Area Directors only in v1. Assume Area Directors only.
- The window constants in D3 (4 meetings, 60 days, 21 days, 60%) are chosen for a weekly-meeting club; a fortnightly club will want different numbers, which is why they are constants, not literals.
