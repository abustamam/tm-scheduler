# ADR-0020: Superadmin read-only impersonation — read-only by construction

Status: Accepted

## Context

ADR-0016 / #183 established the platform superadmin as a capability **orthogonal** to club
membership: `requireSuperadmin` gates platform actions but deliberately does **not** grant ambient
cross-club access — a superadmin still earns per-club rights the normal way. That leaves a real
support/debugging gap: when a superadmin needs to see what a specific club's admin sees (to
diagnose an issue), they have no way in, because every per-club guard resolves userId → Person →
`members` row, and a superadmin has no membership in the target club.

Issue #185 fills the gap with **impersonation** — "View as this club." Triage settled two things:
v1 is **read-only** (mutating "act as" is deferred to #246), and the read-only guarantee must be
**structural**, not a matter of remembering an `if (impersonated) reject` in every mutation.

## Decision

### 1. A session is the only grant, and it is time-bounded + audited

`impersonation_sessions` (`superadmin_user_id`, `club_id`, `mode`, `started_at`, `expires_at`,
`ended_at`) is a superadmin's read-only grant for one club. Active = `ended_at IS NULL AND
expires_at > now()`. Fixed 60-minute TTL; explicit Exit ends it early; at most one active session
per superadmin (starting a new one ends any existing). The `mode` enum ships `read_only` only —
the read-write phase (#246) adds a value without a reshape. The row is the durable audit record;
**starting** a session also writes a `superadmin_viewed` entry to the club's own activity feed
(`target_type: 'club'`, real superadmin identity in `detail`, `actor_member_id` null) so the club
can see that platform support viewed their data.

### 2. Read-only holds by construction — writes never see impersonation

Two new READ-access guards consult the session:

- `requireClubViewAccess(userId, clubId)` — member-level view (real active member OR active
  session). Replaces `requireMembership` in GET server fns.
- `requireClubAdminView(userId, clubId)` — admin-level view (real effective-admin OR active
  session). Replaces `requireClubRole(["admin"])` in GET server fns.

The **mutating guards (`requireClubRole`, `requireMembership`, `getMembership`,
`requireMemberInClub`, `requireMeetingAgendaEditor`) are left impersonation-blind**. They resolve
real memberships only, so an impersonating superadmin — who has no membership — **fails every
write guard by construction**. There are no scattered per-mutation impersonation checks. The
failure mode is fail-closed and asymmetric: forgetting to switch a read fn to the new guard only
breaks a *read* under impersonation; a write can never leak, because no write path references the
impersonation logic at all. (This is why read-only-first is clean and read-write is a deliberate,
auditable inversion in #246.)

Only GET server fns were switched to the read guards; the ~60 POST fns are untouched. (A few niche
read surfaces that gate via `getMembership` directly — e.g. minutes — simply no-op under
impersonation rather than being reworked; an acceptable v1 gap.)

### 3. Surfaced through `getAuthContext`, entered from the console, shown by a banner

When a superadmin has an active session, `getAuthContext` injects the impersonated club as a
read-only **admin** club and forces it active, so the existing authed pages render and the route
`beforeLoad`/`effectiveAdminClub` guards pass. It also returns `impersonating: { clubId, mode,
expiresAt }`, which drives a persistent, unmistakable read-only banner (with a live countdown and
Exit) on every authed page. Entry is a "View as this club" action on the per-club superadmin
console (`_authed/superadmin/$clubId`); Exit ends the session and returns to the console.

## Consequences

- A superadmin can diagnose a club by browsing its real pages read-only, without any ambient
  cross-club bypass and without weakening ADR-0016's invariant.
- The security guarantee is auditable in one place (the write guards never reference impersonation)
  and is covered by an integration test asserting an active session grants the read guards but
  `requireClubRole` / `requireMembership` still throw.
- Write **controls** in the impersonated UI are still rendered (the superadmin's context club is
  admin so pages show admin affordances); clicking one is rejected server-side with an error rather
  than silently succeeding under `read_only`. Comprehensive hiding/disabling of those controls
  remains a follow-up. The read-write "act as" phase shipped in #246 (below).

## Amendment — read-write "act as admin" phase (#246)

Status: Accepted. Read-write is the **deliberate, auditable inversion** of §2 that this ADR
anticipated. Triage (#246) settled: **full admin parity** (no mutation denylist), a **memberless**
superadmin actor, a **required reason**, a **15-minute** TTL, and **no new per-write confirmation**
(irreversible ops keep their existing confirmations).

### Decision

1. **Mode.** `impersonation_mode` gains `read_write` (was `read_only`-only). `impersonation_sessions`
   gains a `reason` column — required (non-empty) for `read_write`, null for `read_only`. TTL is
   mode-dependent: 60 min read-only, **15 min** read-write. Entry is a distinct "Act as admin"
   action on the console (beside "View as this club") that collects the reason. Start logs
   `superadmin_acted` (vs `superadmin_viewed`) with the reason in `detail`.

2. **The inversion, in one place.** Under an active `read_write` session, the mutating guards
   (`requireMembership`, `requireClubRole`, and the admin branch of `requireMeetingAgendaEditor`)
   resolve a **synthetic memberless effective-admin** — `clubRole: "admin"`, `id: null` (no `members`
   row is created, so nothing leaks into rosters/counts/reminders/emails), satisfying any required
   role. `requireMemberInClub` is unchanged (it validates a *target* member). A `read_only` session
   still matches none of these, so §2's by-construction guarantee is untouched for read-only. Guards
   apply the same archive lockout a real admin faces.

3. **Per-write audit.** Every mutation funnels through `logActivity`. When a guard grants a
   read-write session it marks the current request (a `WeakMap` keyed on the request object from
   `getRequest()`, which TanStack Start makes stable across the request's async frames — `enterWith`
   would not survive the guard→handler boundary). `logActivity` reads that marker and stamps
   `activity_log.impersonated_by` = the real superadmin with `actor_member_id` null, so every
   impersonated change is attributable to the real person — without threading an actor argument
   through the ~60 mutation callsites. The marker module imports only `getRequest` (no db/auth), so
   `logActivity` stays lightweight.

4. **UI.** `getAuthContext.impersonating.mode` now spans both modes; the banner has a danger
   (read-write) variant ("Acting as … admin · changes are live") and write controls actually
   function.

### Consequences

- A superadmin can genuinely fix a club's data under a tight, fully-audited window, while read-only
  remains the strictly-safer default and its by-construction guarantee is unchanged.
- Attribution is comprehensive for every audited write (anything through `logActivity`); a mutation
  that writes without logging activity would not be tagged — no such parity-relevant path exists
  today, but it's the boundary to watch.
- Overhead on the write path is one `getRequest()` + `WeakMap` lookup per audited write (no extra
  session query).
