# ADR-0016: Platform superadmin — provisioned onboarding, scoped console

Status: Accepted

## Context

Every authorization decision in the app has, until now, been **per-club**: a user resolves to a
Person (`people.user_id`), then to their `members` row in a given club, and that membership's
`club_role` (`admin` / `member`) gates the action (`requireClubRole` / `requireMembership` in
`src/server/guards.ts`; President / VP Education default a linked account to `admin`). There is no
platform-level role — nobody who can, say, create a brand-new club, see across clubs, or operate a
platform console. Issue #183 introduces that missing tier: a **superadmin**.

The design was grilled to settle four questions that a "just add an admin bit" framing skips.

## Decision

### 1. Provisioned onboarding, not self-serve

Superadmin is **not** something a user can request, purchase, or be granted through the app UI. The
set of superadmins is declared out-of-band by whoever operates the deployment, via a
`SUPERADMIN_EMAILS` environment variable (comma-separated, case-insensitive allowlist). This keeps
the highest privilege tier off the attack surface of the application itself — you cannot escalate to
superadmin by exploiting an in-app flow, only by editing the deployment's env (Railway dashboard).

The env allowlist is reconciled onto a durable `user.is_superadmin` boolean (default `false`) so
that day-to-day guards are a cheap column read, not an env parse on every request.

### 2. Reconcile on sign-in, two-way, fail-closed

A Better-Auth `databaseHooks.session.create.after` hook (`src/lib/auth.ts`) calls
`reconcileSuperadminFlag(userId)` on **every sign-in** — which fires for both newly-created and
returning users, since a session is created either way. The reconcile is:

- **Two-way.** If the user's email is (now) in `SUPERADMIN_EMAILS`, set `is_superadmin = true`; if
  it is not, set it `false`. So adding an email grants on that user's next sign-in, and removing an
  email revokes on their next sign-in. No manual DB surgery, no drift between env and DB.
- **Idempotent.** It only writes when the flag actually changes.
- **Fail-closed.** An unset or empty allowlist yields the empty set — nobody is a superadmin. There
  is no implicit or default superadmin.

Revocation takes effect on next sign-in rather than instantly; immediate session-kill on
de-provisioning was considered out of scope for the MVP (env changes are rare and operator-driven).

### 3. Orthogonal to club membership — additional, never a substitute

Superadmin is a capability layered **on top of** club membership, not a replacement for it. The same
human still earns their own club's admin rights the normal way (their Membership's
`club_role = admin`); superadmin is *additional* platform reach. The two axes are independent:
`is_superadmin` lives on the Better-Auth `user` row; `club_role` lives on the `members` row.

### 4. Scoped console — no ambient cross-club bypass (yet)

`requireSuperadmin(userId)` is a **new, separate** guard. It deliberately does **not** modify
`requireClubRole` / `requireMembership`, and being a superadmin does **not** silently satisfy those
club guards. This rejects an "ambient bypass" where superadmin would implicitly grant admin on every
club — a footgun for accidental cross-club writes and audit-trail confusion. Superadmin powers are
exercised only through explicitly superadmin-gated surfaces (the `/superadmin` console, #182).
Ambient cross-club access and **impersonation** ("act as this club's admin") are deferred to #185.

`getAuthContext` additionally exposes `isSuperadmin: boolean` for the signed-in user so the nav/app
shell can reveal superadmin surfaces — but the routes/UI themselves are #182, not this change.

### 5. Account identity is email-matched (see #188)

Because provisioning keys on **email**, the superadmin identity is only as stable as the email on the
`user` row. Email-match account linking (#188) is the companion mechanism that keeps a single human's
sign-in mapped to one `user` row, so an operator's allowlist entry reliably lands on the right
account.

## Consequences

- New column `user.is_superadmin boolean not null default false` (migration
  `drizzle/0024_naive_hellfire_club.sql`). Reconciled from env on sign-in; read by `requireSuperadmin`
  and surfaced by `getAuthContext`.
- New env var `SUPERADMIN_EMAILS` (documented in `.env.example` and `CLAUDE.md`). Unset ⇒ no
  superadmins.
- The design is intentionally minimal: no in-app granting, no impersonation, no ambient bypass, no
  club deactivation. Those are separate issues (#182 console/club-creation, #185 impersonation/ambient
  access, #186 club deactivation, #187 in-app club-role management).

## Deferred / out of scope

- The `/superadmin` console UI, routes, and club creation (#182).
- Ambient cross-club access and impersonation / "act as" (#185).
- Instant revocation (session invalidation) on de-provisioning — today revocation lands on next
  sign-in.
- In-app granting of superadmin to other users.
