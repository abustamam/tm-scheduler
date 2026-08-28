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

## Follow-up: club soft-archive (#186)

The "club deactivation" deferred above is now built as a **soft-archive**, extending this ADR:

- A nullable **`clubs.archived_at` timestamp** (migration `drizzle/0025_cuddly_molly_hayes.sql`).
  NULL = active; a set timestamp = archived. **Soft and reversible — no hard delete or cascade:**
  archiving retains all club data (members, meetings, speeches, activity log) untouched, and
  unarchive clears `archived_at` to fully restore access. The slug/club number stay reserved.
- **Superadmin-only.** `archiveConsoleClub` / `unarchiveConsoleClub` server fns (`src/server/onboarding.ts`,
  db logic `archiveClub` / `unarchiveClub` in `onboarding-logic.ts`) are `requireSuperadmin`-gated;
  they are exposed from the console club-detail behind a confirm step. A club admin cannot archive
  their own club.
- **What archived blocks:** authed access is rejected by `requireMembership` (the single choke point
  `requireClubRole` also builds on) with an "archived" message; every public no-auth club loader
  (landing, present, print — and the #208 guest-book) returns not-found. The shared archive predicate
  is `isClubArchived` (`src/lib/club-archive.ts`, client-safe so both the guard and the public-loader
  helper `resolveClubOrRedirect` import it). Sign-in is untouched — auth is global; an archived club
  simply shows as inaccessible.

**Corrected 2026-08-10 (#544).** The bullet above claimed "every public no-auth club loader …
returns not-found". That described the **router** loaders only, and was read for two years as
covering the whole public surface. It did not. A `createServerFn` endpoint is addressable directly
— no session, no router — so `resolveClubOrRedirect` guards the *caller*, not the data, and
fourteen public readers kept serving an archived club's roster, meeting schedule, past-meeting
archive, sign-up sheet, role list, mission text, full agenda (assignee names and speech titles) and
live ballot. Three of them were keyed by a **meeting** or **member** id rather than a club id, so
closing the club-keyed readers alone would have left a side door — the legacy `/meetings/:id` URL
meant every pre-takedown bookmark was a working key. Looking a club up by slug also still returned
its name and Toastmasters club number, which is the brand identity ADR-0024's takedown exists to
remove.

The gate is now explicit and, more importantly, **findable**: `isReadableClub` (which had been
buried in `club-logo-logic.ts` since #495, where nobody thought to look for a club-wide check)
moved to `src/server/club-readable-logic.ts` alongside `isReadableClubForMeeting` and
`isReadableClubForMember`. Every public session-less reader calls one, and returns its own
not-found shape rather than throwing, so an archived club is indistinguishable from one that never
existed. `public-readers-archive-gate.guard.test.ts` **derives** its candidate set by walking
`src/server/*.ts` and treating any `createServerFn` with no `require*` call as anonymous, so the
next public reader is enrolled automatically rather than remembered — the allowlist that preceded
it is exactly how this ADR's claim went stale.

Reads only. An archived club still **accepts** anonymous writes (#555), and on-device copies outlive
the takedown — closed for the service worker's caches by #556 below, still open for the logo
endpoint's year-long `immutable` HTTP cache (#517).

**Corrected 2026-08-14 (#560).** The "What archived blocks" bullet calls `requireMembership` "the
single choke point `requireClubRole` also builds on". That was true of authed *writes* and false of
authed *reads*. `requireClubViewAccess` and `requireClubAdminView` (#185 / ADR-0020) resolve their
own memberships and never call `requireMembership`, so they never reached `assertClubNotArchived` —
and 24 GET server fns sit behind them, including the roster loaders that carry member
email (#266) and phone (#559). An archived club kept serving its own signed-in members their
clubmates' contact details. Its name and Toastmasters club number also stayed in the club switcher,
because `getAuthContext` filtered memberships on `status = 'active'` alone; that same list feeds
`activeClubId`, so an archived club could still trigger `ensureScheduleToppedUp` and materialize new
meetings into a club that had been taken down.

Both read gates now grant only through `grantView` in `guards.ts`, which asserts the archive
state first, and `authed-read-gate-archive.guard.test.ts` pins that funnel so a third read gate
cannot be added without it. The check runs *after* the membership resolves, so a non-member still
gets "you're not a member" and cannot use the archive message to probe whether a club exists.
A third class of authed reader reaches neither gate — `getMinutes`, the minutes-PDF API route and
`loadMyCommitments` resolve membership with a bare `getMembership` — so each calls a public seam
(`isReadableClub` / an `archived_at` predicate) directly.

**No exemption for impersonation.** `grantView` rejects on every arm, so a superadmin's read-only
session reads an archived club no more than the club's own members do; `requireSuperadmin` — the
console itself — stays the way to inspect a taken-down club, and ADR-0020 carries the amendment. An
exemption for read-only impersonation *was* written into this fix and dropped, for two reasons worth
recording: the console already hides "View as this club" for an archived club, so it was unreachable
through the product in the direction it was meant for; and because the member arm returns first, it
was silently overridden for an operator who also held a plain membership, which made
`requireClubViewAccess` and `requireClubAdminView` answer OPPOSITELY for the same person.
`impersonation.integration.test.ts` pins the single-actor case and the also-a-member case.

The lesson repeats #544's exactly: the stale claim was a sentence naming ONE enforcement point,
written when that was true and never re-derived. `isClubArchived`
(`src/lib/club-archive.ts`) is now the single place they are listed — this note points at it rather
than becoming another copy to rot. It deliberately states no count: this sentence gave one, the
count changed again in v1.26.0.0, and that is the same failure one level smaller.

Still deferred: superadmin impersonation / ambient cross-club access ("act as", #185).

## Deferred / out of scope

- The `/superadmin` console UI, routes, and club creation (#182).
- Ambient cross-club access and impersonation / "act as" (#185).
- Instant revocation (session invalidation) on de-provisioning — today revocation lands on next
  sign-in.
- In-app granting of superadmin to other users.
