# ADR-0006: Multi-club membership modeled from day one

Status: Accepted

## Context

The app launches for a single club, so the cheapest thing would be to assume one club and
attach everything to a single user. But the founder is himself a member of multiple
Toastmasters clubs, and onboarding other clubs is an explicit later phase. Retrofitting
multi-club into a single-club schema later is a painful, error-prone migration.

## Decision

Model the user↔club relationship as **many-to-many from the start** via `club_memberships`
(carrying `club_role` and `status`). Meetings, role definitions, and slots are all scoped by
`club_id`. Authorization is per-membership: a user's permissions depend on which club's
resource they're acting on.

## Consequences

- Costs nothing today (a user simply has one membership) but makes Phase 4 multi-club a
  feature flag and some UI, not a migration.
- All club-scoped queries must filter by `club_id`; guards resolve the user's membership in
  the resource's club, not a global role.
- A future club-switcher UI is purely presentational — the data model already supports it.
