# ADR-0008: Person identity vs per-club membership

Status: Accepted

> **Status update (2026-07-08):** Phase B shipped in #99/#110 (migration
> `drizzle/0014_spicy_rattler.sql`). `club_role` now lives on `members`,
> `user_id` on `people`, `guards.ts`/`auth-context.ts` resolve roles via the
> membership row, `club_memberships` is dropped, and `vpe` collapsed into
> `admin`. Statements below that describe Phase B as pending are historical.

## Context

The roster `members` table is club-scoped: one row per person per club. Person-level facts —
notably `original_join_date` (first-ever Toastmasters join, identical across every club) —
live on that per-club row, so they duplicate and can drift for anyone in more than one club
(the founder among them). See #64.

The schema also carries two overlapping "person-in-a-club" concepts:

- `club_memberships` — the **authorization** link (`user` ↔ club + `club_role`), read on the
  security path in `guards.ts` / `auth-context.ts`. In practice only the one signed-in
  admin/VPE has rows here.
- `members` — the **roster** (auth-decoupled): every person in the club, the thing meeting
  role slots are claimed against.

The glossary called `club_memberships` "Membership," but the real per-club membership is now
`members`. The founder confirmed the long-term direction: roster members will *eventually* get
real sign-in accounts, so the auth axis and the roster axis converge rather than staying
parallel forever.

## Decision

Model three concepts, with the schema anticipating convergence:

- **Person** (`people`) — one row per human. Keyed by Toastmasters Customer ID (`PN-…`),
  nullable and unique-when-present. Holds every fact that is the same across all of a person's
  clubs: name, email, phone, `original_join_date`, enrolled Pathways paths, and the optional
  `user_id` link to a sign-in account (one login spans all their clubs).
- **Membership** (`members`) — the Person↔Club join; the table keeps the name `members` but
  the *concept* is "a Person's participation in one Club." Holds per-club facts: `club_role`,
  `joined_at`, office (#63), status.
- **`club_memberships`** — retained only as the current auth-role link; slated for absorption
  into Membership. Its `user_id` job belongs on Person, its `club_role` job on Membership.

**Identity resolution / dedupe precedence** (used by import and by future manual merges):

1. **Customer ID** — match when both sides have it (always safe).
2. **Email** — match when Customer ID is absent *and* the email is non-blank and resolves to
   exactly one person on each side.
3. Otherwise treat as distinct people; merging is a manual/admin action. Never auto-merge on
   name, and never auto-merge on an email shared by 2+ distinct people (guards against
   fusing spouses / shared family emails).

**Phasing** (keeps the auth path low-risk):

- **Phase A — #64 (this decision's initial slice):** introduce `people`, add `members.person_id`,
  move `original_join_date` (and canonical name/contact) onto `people`, backfill by the dedupe
  rule (email only, since Customer ID isn't persisted yet), and update `import-members.ts` to
  capture Customer ID and resolve/create people by the precedence above. `club_memberships`,
  `club_role`, and the auth resolution are **left untouched**.
- **Phase B — follow-up issue:** move `club_role` onto `members`, move `user_id` up to
  `people`, repoint `guards.ts` / `auth-context.ts` to resolve role via the membership row,
  and delete `club_memberships`. In the same move, **collapse `club_role` to `{admin, member}`**
  — `admin` and `vpe` already behave identically at every call site (each check is
  `clubRole === "admin" || clubRole === "vpe"`), so `vpe` is cosmetic; it folds into `admin`.
  The permission stays an **explicit** field (not derived from Officer position) so security
  is enforceable on the sign-in account and unaffected by roster edits, but it is **defaulted**
  from office (President / VP Education ⇒ `admin`) so the common case needs no thought (see #63).

Pathways paths are Person-level but are **not** built here (Pathways progress remains out of
scope per `CONTEXT.md`); we only decline to model them onto a membership.

## Consequences

- `original_join_date` (and other person-level facts) have a single home; no cross-club drift.
- Customer ID becomes the durable person key going forward; existing rows without one dedupe
  by email until a future import supplies IDs.
- The target model is locked in without touching the security-critical auth path in #64; the
  auth absorption is a deliberate, separately-tested follow-up.
- Until Phase B, `club_role` still resolves via `club_memberships`; a reader must know the
  Membership glossary term describes the *target* home of `club_role`, which Phase A does not
  yet move.
