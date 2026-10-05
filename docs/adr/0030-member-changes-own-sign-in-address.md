# ADR-0030: A member changes their own sign-in address

Status: Accepted

Relates to: ADR-0029 (contact is a Person fact; this is the "after sign-in it is theirs"
half), ADR-0028 (humans send every message; the exemption below is its class 1), ADR-0008
(Person vs Membership; the household case), ADR-0016 (superadmin from `SUPERADMIN_EMAILS`),
#1091 (this change).

## Context

Since #907 (ADR-0029) a signed-in member's address is `people.email`, and it is also their
sign-in key (`user.email`). Officers see it read-only once the member has signed in, and the
member page promised "Only they can change it". Nothing did: a member whose address changed
could only be fixed by hand in the database.

## Decision

**A member whose account is bound to a Person changes their own address from Account
settings. The new address is verified by a link; the old one is notified.** The ten
decisions in #1091 are the contract. In short:

1. **Verify the new address, notify the old one.** The change happens when the link sent to
   the new address is clicked. The old address does not approve, because the usual reason to
   change is that the old inbox is lost. After a confirmed change, and only then, it gets
   "your GavelUp sign-in address was changed to …; if this wasn't you, contact support."
2. **Only an account bound to exactly one Person** gets the control, and the endpoint refuses
   the rest. The confirm moves `user.email` and that Person's `people.email` in one transaction.
   An account with no Person signs in with the other address instead. An account bound to two
   or more Persons (`people.user_id` is not unique; such duplicates predate #329) is refused at
   request time and again under lock at confirm, with "ask your club officer or GavelUp support
   to merge your records": which record's address to move is a merge decision, not ours.
3. **Collision: the same answer every time, the real answer in the new inbox.** A new
   address is refused when another `user` row carries it, or another Person carries it who
   counts as a holder (bound, or on a roster). That is the bind's own `countsAsHolder`, reused
   by `addressHeldByAnother` (`account-link-logic.ts`) rather than restated, so a change can
   never create the ambiguity the bind refuses. The requester always sees "check the new
   address"; the new inbox gets either the link or "this address is already in use". The
   check runs at request time AND again inside the confirm transaction, with the `user.email`
   unique constraint as the backstop for a race. For this question only, a STORED address is
   trimmed of the Unicode spaces JS `.trim()` strips as well as the POSIX class (NBSP, U+FEFF
   and the rest, plus U+200B): `normalizedEmail`'s narrower trim fails closed for the bind but
   would fail OPEN here, letting a holder stored as the address plus a NBSP be overtaken. Both
   arms run on every request, and a link is minted whichever email is sent, so the response
   time does not say which.
4. **Sessions, OAuth grants and `tmk_` tokens are untouched.** They key off the user id. A
   change is not a security reset.
5. **Superadmin follows the address at once.** `reconcileSuperadminFlag` runs inside the
   confirm transaction, both directions.
6. **Abuse limits.** Three requests per account per hour, and three per client address per
   hour on the same path through Better Auth's own limiter. That limiter keys on client
   address and path and cannot express "per account", so the per-account count is expiring
   rows in Better Auth's existing `verification` table (`change-email-request:<userId>`,
   holding no address, under a per-account advisory lock). No migration.
7. **Links live one hour** and name `{userId, from, to, issuedAtMs}`. Requesting again does
   not cancel an earlier link. Once any change lands, every link minted before it is dead,
   including the link that just landed and including one whose `from` the account has since
   returned to (A→B, then B→A, must not let the old A→B link work again). How: the confirm
   transaction records the landing instant in Better Auth's existing `verification` table
   (`change-email-landed:<userId>`, one row, replaced at each landing, expiring a link
   lifetime later), under the account row lock; a link is applied only if it was minted
   strictly after that instant. The marker holds a timestamp, never an address, so there is
   still no pending-change table: the pending change lives only in the signed link.
8. **Audit.** One `member_edit` entry in every club that holds the member, the member as
   actor, `{before: {email}, after: {email}}` in the detail. Reusing the action needs no
   migration.

**The link opens a page; only its button writes.** A GET of the link renders a confirm page
naming the new address and changes nothing. Its button POSTs the token to
`/member-email/apply`, the only path that runs the confirm. Mail providers and corporate link
scanners prefetch GETs, so a GET that changed the address would apply every change the moment
the mail arrived, defeating "the change happens when the link is clicked". The POST must carry
an `Origin` that is one of the auth instance's trusted origins, checked by the endpoint itself:
Better Auth's global check only validates the origin when a cookie comes with the request, and
this POST is meant to work from a phone with no session. The page is `no-store`, cannot be
framed, and escapes every value it shows.

**The bind re-reads the address in its own statement.** `bindVerifiedPerson` reads the
account's address and then runs its UPDATE; a change confirmed in between would let it stamp
the OLD address onto a second Person and bind it, past a household arm the change itself
moved. The UPDATE now also requires that the account still signs in with that address. This
is not a change to the bind rule, only the same in-statement atomicity its other arms have.

**The writer.** `confirmEmailChange` (`src/server/account-email-change-logic.ts`) is a named
waiver in `person-email-writers.guard.test.ts`, held to `eq(people.userId, …)` in its UPDATE's
own statement: it can only ever move the address of the Person bound to the confirming
account. The Person is locked (`FOR UPDATE`) before the account row, the order the roster
edit takes them in.

### Deviation from #1091's "Key interfaces": Better Auth's `user.changeEmail` stays OFF

The issue's brief suggested enabling Better Auth's built-in change-email flow. It is not
used. Two endpoints of our own, in a small Better Auth plugin (`src/lib/change-email-plugin.ts`,
`/api/auth/member-email/request` and `/member-email/confirm`), do the work instead, because
the built-in flow cannot hold this ADR's rules:

- its link names the OLD address, not the account, and its verify finds the user by that
  address when the link is clicked, so a link can land on whichever account holds the
  address by then;
- its write runs outside any transaction of ours and knows nothing of `people.email`, our
  collision rule, superadmin or the activity log;
- its silent no-op for an existing user sends nothing, where decision 3 wants the new inbox
  told the address is in use;
- it needs `emailVerification.sendVerificationEmail`, which also arms Better Auth's public
  `/send-verification-email` sender.

Its verify is also a state-changing GET, which a link scanner would trigger (above). Being a
plugin keeps what the built-in flow did offer: Better Auth's limiter and origin check on the
request, and a link signed with the auth secret. The token carries a `purpose` claim
no other token signed with that secret has, so neither flow's tokens are accepted by the
other.

### The mail this sends, and why it is exempt from ADR-0028

All three messages are ADR-0028's **class 1, account-security mail to the account's own
address**, sent because the account's holder just acted on their own account:

- the verification link, sent to the new address the member typed;
- its "this address is already in use" variant, sent to that same new address instead of a
  link;
- the "your sign-in address was changed" notice, sent to the old address after the member
  confirmed.

None carries club content: no roles, no dates, no meeting, no club name. No human could send
them, because their job is to prove control of an inbox or to warn the account's own former
inbox. Nothing here touches ADR-0028's class 2, the officer-sent roster invite, which stays a
separate exemption.

This exemption is exactly those three messages. It does not mean "the app may email
members": a message prompted by anyone other than the account holder, sent to anyone other
than that account's own old or new address, or carrying anything beyond the change itself, is
outside it and needs a new ADR.

## Consequences

- The member page's read-only hint now says where the change is made: "Only they can change
  it, from Account settings."
- Signing in with the old address after a change reaches a brand-new, empty account, never
  this one; no Person carries the old address any more.
- **Accepted residual.** Like the bind, the Person arm of the collision check reads under READ
  COMMITTED: an officer typing the same address onto an unbound Person in another transaction
  at the same instant is not serialised against the confirm. The `user` arm is backstopped by
  the unique constraint. This is the same residual ADR-0029 accepts for the bind.
- Out of scope, unchanged: an officer or superadmin changing a bound member's address, "sign
  out everywhere", and merging duplicate Persons (the "already in use" email points at the
  existing manual merge).
