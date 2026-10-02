# ADR-0029: Contact is a Person fact

Status: Accepted

Relates to: ADR-0008 (Person vs Membership), ADR-0026, #906 (phone), #907 (email, this
change), #756 (the split this supersedes), #755 (the blast-radius guard reused here), #759.

## Context

ADR-0008 put name, email and phone on the Person, "the facts identical across every club".
The schema left per-club copies behind on `members` anyway, and #756 then turned the email
copy into the vouch a sign-in bound on:

- `people.email` was the verified identity address, written only by the sign-in bind;
- `members.email` was a per-club, officer-typed "claim", and `rosterPermitsBind` required a
  membership row to carry the address AND exactly one club to hold the Person.

That had two costs. A member of two clubs could not sign in by email at all, because the
"exactly one club" arm refused them by construction. And an officer fixing a typo had to
know which of two columns they were fixing. In Toastmasters International your email is
your identity in every club you belong to, and the maintainer ruled that it is a Person fact
here too: an officer may correct it before the member signs in, because it may be a typo;
after sign-in it is theirs.

## Decision

**Phone (#906) and email (#907) live only on `people`.** `members.phone` and
`members.email` are dropped. Every reader reads the Person through `members.person_id`.

**Who may write `people.email`:**

| Person state | Officer roster edit | CSV import / bulk paste | Guest convert (matched Person) | Sign-in bind |
|---|---|---|---|---|
| Bound (`user_id` set) | refused, field read-only | not written, row reported | not written | n/a |
| Unbound, held only by the writing club | allowed (typo repair) | fill-only | fill blank only | writes the verified address |
| Unbound, held by 2+ clubs | refused; a superadmin fixes it | not written, row reported | not written | writes the verified address |

Every club-side writer carries BOTH predicates in its UPDATE's own WHERE —
`isNull(people.userId)` and `soleHoldingClub(clubId)` (`account-link-logic.ts`: exactly one
distinct club holds a membership of the Person, and it is this one). Being in the statement
is what makes a bind landing between a form's load and its save a no-op rather than an
overwrite. `person-email-writers.guard.test.ts` names every writer and holds each club-side
one to both tokens. The officer edit also locks the Person row (`FOR UPDATE`) first.

The superadmin first-admin repair (`updateUnclaimedAdminEmail`) keeps its own waiver with
`isNull(people.userId)` only: the operator is the one person who may repair a Person several
clubs share. A plain INSERT of a brand-new Person carries an address freely.

**The bind rule** (`rosterPermitsBind`) — a verified address binds a Person when:

1. the Person's own `people.email` normalises to it;
2. `people.user_id IS NULL`;
3. the Person holds at least one membership (a club vouches);
4. no OTHER Person, bound or not, carries it.

`rosterConflictFor` is its exact complement, and `roster-obstacle.guard.test.ts` holds the
two together over a matrix of roster shapes.

**Why dropping "exactly one club" is safe.** That arm existed because any club holding a
Person could type the vouch. Now a club-side writer can set an address only while that club is
the Person's sole holder and nobody has bound them, so a club that SHARES a Person cannot
re-key them. Arm 4 still refuses an address two Persons carry — ADR-0008's
never-auto-merge-on-a-shared-email.

## Consequences

- Members of several clubs sign in by email.
- A typo is repaired on the member page, until the member signs in; after that the field is
  read-only and says why.
- The CSV importer's email arm matches `people.email` globally. A row carrying the address of
  a Person only another club holds now resolves to that Person and is refused as `foreign`
  (#759), exactly as a foreign Customer ID is — rather than minting a second Person for the
  same human.
- **Accepted residual.** The officer edit's Person lock does not serialise a second club
  attaching a membership in the same instant. That attach can only have matched the Person
  by their current address or Customer ID, so the worst case is one club's typo fix racing
  another club's import of the same human. Locking every attach path was judged not worth it.
- **Known gap, unchanged by this ADR.** A Person with NO memberships (a removal, a convert
  undo) is re-attachable by the club that last removed them (#855); that club is then the sole
  holder and may set the address. That was equally true of the `members.email` vouch.
- Migration 0109 backfills each unbound Person from the one address its memberships agree on,
  snapshots every change in `people_email_backup_2` and every dropped membership address in
  `members_email_backup`, and drops the column. A rollback restores `people.email` only where
  `user_id` is still null: an address a bind has since verified is never overwritten.

Supersedes #756's split of the address into a verified `people.email` and a per-club
`members.email` vouch, and ADR-0008's per-club contact copies.
