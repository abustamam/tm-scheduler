# ADR-0031: A guest is a Person

Status: Accepted

Relates to: ADR-0008 (Person vs Membership), ADR-0013 and ADR-0018 (guests and the pipeline),
ADR-0029 (contact is a Person fact), ADR-0030, #1010 (the club write lock), #635 (link a guest
to a member), #1124 (this change, the series' first step), #1125, #1126, #1127.

## Context

A guest was a per-club `guests` row with its own name, email and phone. Nothing linked the same
human across clubs: a visitor who had been to two clubs was two unrelated rows, and a guest who
became a member was a Person created from scratch. Members already have the Person / Membership
split (ADR-0008), and ADR-0029 made contact a Person fact. The maintainer ruled on 2026-10-07
that **a guest is a Person too**.

## Decision

### The shape

`guests` stays the per-club guest RECORD (stage, kind, home club, who introduced them, the
membership they converted to), as `members` is the per-club membership. It gains
`person_id`, pointing at the human. Name and preferred name stay per club on the guest row, like
`members.name`, and `people.name` is the fallback. The eight tables that reference `guests.id`
(invites, role slots, attendance, table-topics speakers, awards, votes, ballot guests, speeches)
do not change.

- **`ON DELETE RESTRICT`.** A Person delete that forgot its guests fails loudly instead of
  silently deleting visit, role and speech history.
- **No unique index on `(club_id, person_id)`.** Several converted guest rows legitimately share
  one member Person (#635). A partial index on `converted_membership_id IS NULL` would abort a
  member delete, whose `SET NULL` clears them all at once. Uniqueness is checked in code.
- **Nullable in #1124 on purpose.** During the deploy swap the old container still inserts
  guests without a Person. #1125 re-backfills and sets NOT NULL. `ensureGuestPerson` repairs a
  null on its next convert.
- **One writer.** `createGuestRecord` is the only non-test inserter of `guests`: it mints the
  Person `{ name, preferredName }` and the guest row in one transaction, so a failed guest insert
  leaves no orphan Person. `guest-insert.guard.test.ts` fails on any other `.insert(guests)`.

### The backfill

A converted guest takes its membership's Person. Every other guest, stranded `joined` ones
included, gets its own fresh Person carrying its name only. The backfill does no cross-row
merging: ADR-0008 forbids merging on name, and the public guest book never links across clubs.
A duplicate is repaired afterwards through the superadmin merge tool, which lists guest-only
Persons with a "Guest" badge (`guestOnlyPerson()`, `account-link-logic.ts`).

### Convert

A convert that finds no member of THIS club to match (the #759 club-scoped dedupe) puts the
membership on the guest's own Person. It inserts no `people` row and records
`createdPerson: false`, so an undo never touches that Person. As the Person becomes a member,
the guest row's email and phone are copied onto it, in the same transaction, under three
conditions each carried in the UPDATE's own WHERE: the Person is not signed in, the field is
blank, and the Person is held by guest rows only. That last predicate reads false the moment
the membership exists, so the copy runs before the membership insert. This refines ADR-0029's
"guest conversion never writes an EXISTING Person's address": the Person here is the guest's
own, name-only and unbound, exactly what a fresh Person was before. A matched Person (a member
of this club) is still never written. The dedupe-hit path is unchanged, and the accepted
residual is that such a human has two Persons until a superadmin merge.

### Contact (implemented in #1125, recorded here)

The Person owns their contact; clubs are custodians until the person speaks for themselves.
A guest's email and phone live on, and are edited through, their Person.

- **Signed in:** only the person changes it (ADR-0030).
- **Guest-only and not signed in:** any club holding a guest record on them may correct it.
  The fix shows in every club, because it is one person with one address.
- **A member somewhere and not signed in:** ADR-0029 unchanged. Only the sole club holding a
  membership may set it. A guest record never counts as a holder and never locks a member.
- **The anonymous guest book** fills a blank only on a guest-only, unbound Person no other club
  holds.
- A contact edit on a bound or member Person is refused with a reason.

### Linking across clubs (implemented in #1127, recorded here)

Linking two clubs' records of one human, or separating them, is done only by an admin or officer
of BOTH clubs. A guest never links themselves.

### The lock protocol

Every writer in this series that touches more than one of these takes them in this order:

1. `lockClubForWrite` for every affected club, sorted by id;
2. then the `people` rows `FOR UPDATE`, sorted by id;
3. then the `guests` rows.

This extends the club-lock-first rule of #1010 (`src/server/club-write-lock.ts`). `mergePeople`
used to lock both Persons before any club lock; #1124 reverses it, because a convert, a
guest-book capture and #1127's link all take the club lock first, and a merge holding a Person
while it waited for a club lock closed a cycle with them. Its guest-row lock is `NO KEY UPDATE`:
a slot assignment holds its slot and then key-share-locks the guest it names, and a `FOR UPDATE`
there would deadlock with the merge's own collapse.

**The read-then-lock rule.** A path that must read a row to learn which clubs or Persons to
lock (convert, `mergePeople`, #1127's actions) reads it WITHOUT locking, takes the locks in
protocol order, and re-reads. If the set of clubs or Persons changed, it refuses with
"This record changed. Try again." and writes nothing. Club delete keeps its existing club lock
mode and takes its Person locks after it.

### Deletes

`mergePeople` moves the absorbed Person's guest rows to the keeper before it deletes the
absorbed Person. Club delete deletes a guest-only Person whose only guest rows were in the
deleted club, and keeps a Person with a guest row in another club
(`personsWithOtherClubHistory` counts `guests` too). Deleting a member who has several converted
guest rows succeeds: `converted_membership_id` is `SET NULL` and nothing forbids it.

### Rollback

Forward repair only. Revert the PR's code and repair data forward; there is no down migration.
The column is additive and nullable, so reverting the code leaves `person_id` populated and
unread. Backup tables, where a later step makes them, are forensic copies, not a restore path
(precedent: #1089).

## Consequences

- Every guest has a Person, so #1125 can move contact onto it and #1127 can link a human across
  clubs without a second identity concept.
- Undo of a convert keeps the guest's Person and the guest row, and the guest returns to
  `following_up`. The undo's speeches and Pathways checks are keyed on `createdMembership`
  rather than `createdPerson`, which is always false for a new convert. The one case this
  over-refuses is a guest Person that a merge had already made a member elsewhere; it refuses
  an undo and deletes nothing.
- **Accepted residual.** A dedupe-hit convert leaves the guest's own Person behind as a second
  guest-only Person for a human who is also a member, until a superadmin merges them.
- The merge tool's lists include guest-only Persons so that residual can be repaired.
