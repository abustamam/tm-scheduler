# ADR-0017: Membership-dues tracking — periods as data, unpaid as absence

Status: Accepted

## Context

The Treasurer office (`officer_terms` position `treasurer`, resolving to club `admin` via
effective-admin) had no dedicated feature. Nothing in the schema modeled dues, billing periods,
or payment status. `memberships.status` (`active` / `inactive`) exists but tracks roster/season
renewal, not money — conflating the two would let a missed payment silently drop a member from
sign-up, rosters, and pickers, which is not what "hasn't paid yet" means.

Issue #206 asks for a status-only dues tracker: club-defined periods, per-member paid/waived
status, a "who owes" overdue report — and explicitly **no** payment processing.

## Decision

### 1. Dues periods are data, not hardcoded cadence

A club bills differently (annual, semi-annual, custom amounts and dates), so a **`dues_periods`**
table (`club_id` cascade, `label`, `due_date`, optional `default_amount_cents`) is the identity a
dues record keys off. The default cadence is semi-annual: the create-period UI offers the
Toastmasters International renewal dates (Apr 1 / Oct 1) as one-click presets, without forcing them.

### 2. A dues record is sparse; "unpaid" is the absence of a row

**`member_dues`** is keyed on `(membership_id, dues_period_id)` (unique) with a `status`
(`paid` / `waived`), optional `amount_cents`, and optional `paid_at`. There is **no `unpaid`
value and no pre-seeding** of member×period rows: a member owes a period exactly when they have
no `paid`/`waived` row for it. This keeps the table sparse (a new period costs zero rows) and the
overdue query a simple "active members minus covered pairs".

### 3. Full-year pre-payment is two rows, written together

A member paying a full year — even in a semi-annual club — is recorded as **two `paid` rows** (this
period + the next period by due-date) written in one transaction from a single "record payment →
full year" action, sharing one `paid_at`. Per-row `amount_cents` is optional (split the total or
leave a row blank). Because the up-front payment writes the *next* period's row too, full-year
payers are excluded from the overdue report for free — they are "covered" for both periods.

### 4. Amounts are integer cents

`default_amount_cents` / `amount_cents` are integers, so period totals sum exactly (no binary-float
drift) and are trivially aggregated. Nullable throughout — a club may track status without ever
recording a dollar figure. The UI formats cents to a localized currency string only at the edge
(`src/lib/dues.ts`). This deviates from the brief's nominal `default_amount` / `amount` column
names purely in representation; the semantics (optional amount, summed collected total) are exact.

### 5. Dues and roster status stay fully decoupled

**No dues action ever writes `memberships.status`.** Overdue is a report, not an automation: it
never flips a member `inactive`. This is enforced by an integration test that snapshots every
member's status across record / full-year / waive / undo and asserts it is unchanged.

### 6. Derived reads, admin-gated writes, server-module split

Per-member period status, the totals, and the overdue set are **derived** at read time from active
`members` LEFT JOINed to the sparse `member_dues` — the project's derived-not-stored style (cf.
ADR-0005, reporting-logic.ts). All server fns are gated on `requireClubRole(userId, clubId,
["admin"])`; Treasurer / President already resolve to `admin`. The db logic lives in
`src/server/dues-logic.ts` (directly integration-testable) behind thin `createServerFn` wrappers in
`src/server/dues.ts`, per the server-module split enforced by `server-modules.guard.test.ts`.

## Consequences

- The Treasurer view (`/admin/dues`, admin-only) has a period selector defaulting to the active
  period (the one whose window — its due date up to the next period's — contains today, else the
  nearest upcoming), a per-member roster with record / full-year / waive / undo, status-count and
  collected-amount totals, and an overdue list linking to member profiles.
- **Out of scope, deliberately:** payment processing / money movement (Stripe, invoicing,
  receipts); auto-flipping roster status; automated renewal reminders (gated on the reminder poller,
  #7 — the overdue list ships now, auto-reminders are a follow-on); dues history for `inactive`
  members. Guest-conversion / retention is #208, not dues.
- Activity-log entries per payment/waiver were left out (the brief marks them optional, and adding a
  value to the shared `activity_action` enum would widen the diff and collide with sibling work); it
  can be added later behind a new enum value if an audit trail is wanted.
