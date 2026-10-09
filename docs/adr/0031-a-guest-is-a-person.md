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
Persons with a "Guest" badge (`unboundGuestOnlyPerson()`, `account-link-logic.ts`).

### Convert: adopt a pristine Person, otherwise mint a fresh one

The maintainer's ruling of 2026-10-09 (option A). A convert that finds no member of THIS club to
match (the #759 club-scoped dedupe) looks at the Person the guest row names, and **adopts it only
if it is PRISTINE**. Otherwise the guest gets a fresh Person, which is what a convert did before
#1124.

A Person is pristine for a guest only if ALL of these hold (`pristineGuestPerson(guestId)`,
`account-link-logic.ts`, the one definition):

- nobody has signed in as them (`user_id IS NULL`);
- no membership in any club, in any status;
- no speech, no Pathways enrolment, no charter-helper row;
- no guest row but this one, in any club;
- no email and no phone;
- no activity record showing they ever held a membership: a `member_remove` naming them
  (`detail.personId`, the shape `applyMemberRemove`, an undo and the CSV importer's release lookup
  use) or a `member_add` naming them (convert's record).

The predicate is in the adopt UPDATE's own WHERE, and the UPDATE matching a row IS the decision,
so a sign-in or a membership that lands after any earlier read makes it match nothing and the
convert mints a fresh Person instead. It reads false the moment the membership exists, so the
statement runs before the membership insert.

- **Pristine: adopt.** The membership goes on the guest's own Person, no `people` row is inserted
  (`createdPerson: false`), and convert writes the guest row's name, goes-by name, email and phone
  onto it. The contact is blank by the predicate, so that is a fill. The name and goes-by name are
  the guest row's because an officer's correction since capture lives only there, and
  `people.name` / `people.preferred_name` are the fallback every other club reads. This is the
  fourth behavior change the spec did not list: a Person made by `createGuestRecord` no longer
  goes stale when an officer renames the guest.
- **Not pristine: a fresh Person.** Convert mints a Person carrying the guest row's name, goes-by
  name, email and phone, points the guest row at it, and converts onto it (`createdPerson: true`).
  The old Person is left EXACTLY as it is and is NOT deleted: it is somebody's history, or the
  release target of an undone convert (#875).

**Why contact on a guest's Person counts as evidence.** In #1124 nothing puts contact on a guest's
Person except a convert or a member-level edit, so contact means the Person was a member.
**#1125 moves a guest's contact onto its Person, and must replace this signal**; without that every
guest Person with an email would read as a former member.

Why not adopt whatever the guest row names (the first cut of this change, which overwrote the
Person's contact and name from the guest row, then restricted it to Persons held by guest rows
only). A re-review found Persons that fit that rule and were not the guest's: one a merge had made
a former member's, one an earlier convert had made a member that an officer had since corrected,
one a wrong link had pointed at another member. Writing the guest row's values onto them re-keyed
a real person and let an address typed on the anonymous guest book become the sign-in key of a
Person with history. Every one of those fails a pristine condition, so each gets a fresh Person.
Clearing the contact at undo was also tried and rejected: it stops the undoing club's own roster
CSV matching the Person convert minted (#875), which then creates a second Person for one human.
The cost of the rule is accepted: an undo followed by a re-convert always leaves the first Person
behind as an orphan with a release record, and a typo'd address stays on it; it holds no
membership, so nothing vouches for it.

This refines ADR-0029's "guest conversion never writes an EXISTING Person's address": a Person
written here is one that, by the predicate, nobody has any claim on, and is exactly what a fresh
Person was before. A matched Person (a member of this club) is still never written. The dedupe-hit
path is otherwise unchanged, and the accepted residual is that such a human has two Persons until a
superadmin merge. It locks BOTH Persons, the guest's and the matched one, in id order before it
writes.

**Undo leaves the contact alone and leaves the guest where it is.** The guest keeps naming whatever
Person it named; the next convert decides, and a Person that holds a membership, has contact or has
a removal on record is not pristine. Undo resolves the Person through the membership row's CURRENT
`person_id`, not the activity record, because a merge since may have deleted the Person the record
names. A link (#635) points the guest at the member's Person, as a converted guest does, and takes
back the guest's old Person when nothing else references it. A collapse of two memberships carries
`guests.person_id` along with `converted_membership_id`.

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

**Person lock strength.** The Person locks are `FOR NO KEY UPDATE`, except in a path that DELETES a
Person (a guest delete, a link, `mergePeople`), which takes `FOR UPDATE`. `NO KEY UPDATE`
conflicts with every other writer of the row, `applyMemberEdit`'s `FOR UPDATE` included, and not
with the key share a foreign-key insert takes on it. A speaker claim holds the slot or the
membership and then inserts a speech, key-sharing the Person, and takes no club write lock, so a
`FOR UPDATE` on a Person held while waiting for that slot or membership was a deadlock. A
membership collapse locks the two memberships' Persons before it writes either membership row,
for the same reason in the other direction: it now re-points `guests.person_id`, which key-shares
the keeper's Person, and the roster edit locks that Person before the membership.

**The read-then-lock rule.** A path that must read a row to learn which clubs or Persons to
lock (convert, `mergePeople`, #1127's actions) reads it WITHOUT locking, takes the locks in
protocol order, and re-reads. If the set of clubs or Persons changed, it refuses with
"This record changed. Try again." and writes nothing. Club delete keeps its existing club lock
mode and takes its Person locks after it.

### Deletes

`mergePeople` moves the absorbed Person's guest rows to the keeper before it deletes the
absorbed Person, counts them in `movedCounts.guests`, and writes an audit row for every club
whose guest record moved. Club delete deletes a guest-only Person whose only guest rows were in
the deleted club, and keeps a Person with a guest row in another club
(`personsWithOtherClubHistory` counts `guests` too) and a Person somebody has signed in as, which
is an account and not a guest, and a Person that owns a speech, a Pathways enrolment or a
charter-helper row (a guest row never made the deleted club the owner of that history; a guest-only
Person merged with a former member of another club still carries it). Deleting a guest deletes its
Person too, in the same transaction and under the same lock protocol, when nothing else references
it: no sign-in, membership, other guest row, speech, Pathways enrolment or charter-helper row
(`club_charter_helpers.person_id` is `SET NULL`, and a helper with no name would then violate its
identity check). That is the one predicate, `unreferencedUnboundPerson()`, which a club delete also
applies to its guest-only Persons. A Person a guest delete or a link deletes loses its
`people_email_backup` rows too, as in a club delete, and only that table. Deleting a member who has several converted guest rows
succeeds: `converted_membership_id` is `SET NULL` and nothing forbids it. A client-supplied guest
id that names ANOTHER club's guest is refused, not treated as a replay.

### Rollback

Forward repair only: there is no down migration, and reverting the code is not a clean undo.
The column is additive and nullable and stays populated, but the OLD `mergePeople` deletes the
absorbed Person without re-pointing `guests.person_id`, so after a revert it fails with 23503
(`RESTRICT`) for any absorbed Person a guest row names. The old container does the same during
the deploy swap. Repair data forward: re-point those guest rows, or run the merge on the new
code. Backup tables, where a later step makes them, are forensic copies, not a restore path
(precedent: #1089).

**The deploy swap leaves two kinds of row behind, and #1125's re-backfill (null `person_id`
only) repairs one.** A guest the old container inserts has a null `person_id`; #1125 gives it a
Person. A guest the old container CONVERTS keeps the Person the migration gave it while its
membership sits on a different one the old convert minted, so `guests.person_id` differs from
its membership's `person_id`. That is not null, so #1125 does not touch it. Nothing reads the
difference as wrong (an undo resolves the membership's Person itself), and the `## Prod check`
counts these rows right after the swap so they are known.

## Consequences

- Every guest has a Person, so #1125 can move contact onto it and #1127 can link a human across
  clubs without a second identity concept.
- Undo of a convert keeps the guest row, and the guest returns to `following_up` on the same
  Person. A re-convert then adopts it only if it is still pristine, which after an undo it is not
  (the undo leaves a removal on record), so the guest gets a fresh Person. The undo's speeches and
  Pathways checks are keyed on `createdMembership` rather than `createdPerson`, which is false
  whenever convert adopts. The one case this over-refuses is a guest Person that a merge had
  already made a member elsewhere; it refuses an undo and deletes nothing.
- **Accepted residual.** A dedupe-hit convert leaves the guest's own Person behind as a second
  guest-only Person for a human who is also a member, until a superadmin merges them.
- The merge tool's lists include guest-only Persons so that residual can be repaired.
