# Digital voting

The room votes for Best Speaker, Best Evaluator and Best Table Topics from their
phones. A QR code on the projector and on the printed agenda opens a public
ballot; the Ballot Counter opens and closes each vote, watches the count, and
taps the winner into the record.

Shapes the voting half of #510. The digital-comments half of that issue is out
of scope here and stays unshaped.

## Why

The Vote Counter role (`vote_counter` in `src/lib/role-template.ts`) hands out
slips of paper, collects them, and tallies by hand while the meeting continues
around them. The counting is the least valuable minute of their meeting and the
one most likely to go wrong.

Everything a digital ballot needs to land in already exists:

- `meeting_awards` holds one winner per `(meeting, category)` under a unique
  index, member XOR guest, and is already what the minutes, the minutes PDF and
  the printed awards beat read.
- `awardEligible` in `src/server/minutes-logic.ts` already derives the candidate
  set per category — speaker-slot holders, evaluator-slot holders, and the
  meeting's Table Topics speakers.
- `table_topics_speakers` already stores the impromptu speakers, and
  `addTableTopicsSpeaker` already has a roster + guest + add-a-guest picker.
- `guest-book` (`src/routes/club.$clubId_.guest-book.tsx` + `submitGuestBook`)
  is the working precedent for a public, no-auth, shell-escaped write surface.
- `qrcode.react` is already a dependency, already rendering the guest-book URL
  on the VP Membership page.

So the gap is a ballot, a place to put votes, and a way to name Table Topics
speakers while they are still happening.

## Product stance

The recorded principle is that automation aids the human Toastmasters roles
rather than replacing them. This design keeps the Ballot Counter in charge: they
decide when each vote opens and closes, they alone see the running count, and
the winner reaches `meeting_awards` only when they tap it. The app does the
arithmetic. The human runs the segment.

## Decisions

| Question | Decision |
| --- | --- |
| Who operates the vote | The Ballot Counter — whoever holds the meeting's `vote_counter` slot |
| Voter identity | Pick your name, reusing the existing name-pick path |
| Who may vote | Members and guests |
| Self-voting | Allowed — not blocked |
| Table Topics capture | The Ballot Counter, reusing the existing minutes picker |
| Who sees the count | Ballot Counter only; everyone else sees participation |
| Winner → `meeting_awards` | Ballot Counter confirms; nothing auto-writes |
| Paper ballots into the tally | Out of scope for v1 |
| End of voting | Completing the meeting force-closes any open vote |
| Transport | Polling, not SSE |

### Why polling and not SSE

There is no realtime infrastructure anywhere in `src/` today. The "which votes
are open" payload is a few hundred bytes; twenty phones polling it every five
seconds is nothing. SSE through Railway means reconnect handling and
proxy-buffering work for no user-visible gain.

### Why the live element is smaller than it looks

Each vote opens *after* its segment ends. By the time any voter sees the Best
Table Topics ballot, the Ballot Counter has already captured the speakers, so
the candidate list is complete and static. Nothing has to stream. Polling exists
only so a phone left open on the ballot page flips to the next vote by itself.

## Data model

Three new tables — two carrying the feature, one existing only to bound the
public guest-creation path. No change to `meeting_awards`,
`table_topics_speakers` or `role_slots`.

### `meeting_vote_sessions`

One row per `(meeting, category)`, created the first time that vote is opened.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `meeting_id` | uuid | → `meetings.id`, cascade |
| `category` | `award_category` | reuses the existing enum |
| `opened_at` | timestamptz not null | |
| `closed_at` | timestamptz null | **null means open** |
| `opened_by_member_id` | uuid null | → `members.id`, set null |
| `created_at` / `updated_at` | timestamptz | |

- `uniqueIndex(meeting_id, category)` — mirrors `meeting_awards`' own unique
  index so sessions, awards and categories line up 1:1:1.
- Re-opening a closed vote sets `closed_at = null` on the existing row
  (`ON CONFLICT DO UPDATE`) rather than inserting a second one. The open/close
  history lives in `activity_log`, not here.

### `meeting_votes`

One row per ballot cast.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `session_id` | uuid | → `meeting_vote_sessions.id`, cascade |
| `voter_member_id` | uuid null | → `members.id`, set null |
| `voter_guest_id` | uuid null | → `guests.id`, cascade |
| `candidate_member_id` | uuid null | → `members.id`, set null |
| `candidate_guest_id` | uuid null | → `guests.id`, cascade |
| `created_at` / `updated_at` | timestamptz | |

Following the `meeting_attendance` precedent exactly:

- `uniqueIndex(session_id, voter_member_id)` and
  `uniqueIndex(session_id, voter_guest_id)` — **plain, not partial**, so
  `ON CONFLICT` can infer them as arbiters. Postgres treats NULLs as distinct,
  so the member rows (guest null) never collide with the guest rows (member
  null). This is what enforces one vote per person per category, at the
  database rather than in application code.
- `check(voter_member_id is null or voter_guest_id is null)` and the same for
  the candidate pair.
- `index(session_id)` for the tally read.

Changing your mind is an upsert on the voter arbiter, so re-voting inside an
open window replaces the pick instead of adding a second row.

### `meeting_ballot_guests`

Which guests this meeting's public ballot created: `(meeting_id, guest_id)`
composite primary key, both cascading, plus `created_at`.

It exists for one reason — the per-meeting creation cap needs something to count
against, and `guests` is club-scoped. Counting club guests would throttle a club
with years of visitors instead of a script hammering one meeting URL. Nothing
reads it except the cap.

### Enum additions

`activity_action` gains `vote_open` and `vote_close`.

Deliberately not `vote_cast`: logging every ballot would put voter identity into
a feed the club can read, which exposes the electorate for no benefit. The tally
is the record.

### What is deliberately absent

- **No `paper_count` column.** Paper entry is out of scope for v1; adding it
  later is one nullable integer on the session row.
- **No vote-secrecy flag.** Votes are attributed in the database because
  `voter_id` is what makes the unique constraint work. Secrecy is a query-shape
  property: the tally function returns counts, never rows.
- **No winner column on the session.** The winner is `meeting_awards`, which
  already exists and is already what every downstream surface reads.

### Stated property, not an accident

Because votes are attributed, anyone with database access can see who voted for
whom. Paper slips are genuinely anonymous; this is not. That is the price of
enforceable one-person-one-vote, and it is the right trade for a club app — but
it is a property of the design, and it belongs in writing.

## Surfaces

### 1. The ballot — `src/routes/club.$clubId_.meeting.$meetingId.vote.tsx`

The trailing `_` escapes the club shell, matching `present`, `print` and `word`,
and the guest-book precedent. Public, `robots: noindex, nofollow`.

Loader: `resolveClubOrRedirect(params.clubId, location)` then
`getPublicMeetingByKey({ clubId, key })`, with the same
`meeting.clubId !== club.id → notFound()` check the print route makes. The
date-based meeting URL means `/club/harbor-city/meeting/2026-08-15/vote`
resolves, so a QR can be printed days ahead of the meeting.

Three states, in order:

**Identify.** Reuses `pick-name-form.tsx`. Pre-filled from
`readStoredMember(clubId)`, so a member who has used the public club page never
picks again. A guest picks from this meeting's guest list or adds themselves via
the existing `captureGuestVisit`. Stored under a new `gavelup:voter:<meetingId>`
key as `{ kind: 'member' | 'guest', id, name }` — meeting-scoped rather than
club-scoped, because a guest identity is not a standing one and a shared phone
should not carry last month's pick.

**Waiting.** "Voting isn't open yet." Polls `getBallot` every 5s.

**Vote.** One card per open category, candidate names as large tap targets.
Tapping casts immediately and shows a confirmed state with "change my vote"
while the window is open. When the Ballot Counter closes a vote the card flips
to "Voting closed" on the next poll.

The payload carries **ids and display names only**. No emails, no phones. The
public club sheet is a soft gate and this route is fully public, so the no-PII
rule is absolute here and gets its own guard test.

### 2. The Ballot Counter panel — on the existing meeting page

Gated by a new `resolveVoteCounterAuthz` in `src/server/meeting-authz-logic.ts`,
built on the same shape as `resolveWordOfTheDayAuthz`: allowed when the caller
is a club `admin` (session), or when the self-asserted `memberId` holds the
meeting's `vote_counter` slot. Identity is the **role key**, not the role name,
so a club that renamed the role to "Ballot Counter" still works.

Three rows, one per category:

- **Open** / **Close**.
- The live count, polled every 5s, visible **only here**.
- Who has voted — names, not choices. A cheap integrity check ("Dave voted but
  Dave went home") that preserves ballot secrecy because it reports
  participation, not preference.
- On close: ranked results and a **Set winner** tap calling the existing
  `setAward`. A tie surfaces as a tie and still requires the pick. Nothing
  auto-writes.

Above those rows sits the **Table Topics speaker capture**: the existing
`addTableTopicsSpeaker` picker (roster + guests + add-a-guest), lifted out of
the minutes UI into a component both surfaces render. Names land in
`table_topics_speakers`, so capturing them for the ballot fills in the minutes
and the minutes PDF as a side effect.

### 3. Present mode — QR on the vote slides

`voteSpeaker`, `voteTableTopics` and `voteEvaluator` already exist in the deck.
Each gains a `QRCodeSVG` of the ballot URL and a participation badge. The
projector is already showing "Vote for Best Speaker" at exactly the moment
people need to scan.

### 4. Printed agenda — QR in the footer

One QR for clubs that do not project. Print CSS is invisible to every gate
except the page-count assertion added in v1.8.4.0 (#502) — a stray block once
shipped a blank second page past six test files and two reviews — so this
change re-runs that gate rather than being eyeballed.

### The participation badge

Server-side we cannot know who is in the room: the name-pick identity lives in
localStorage and is invisible until someone actually votes. So the badge reads
**"7 votes in"**, and **"7 of 12 present"** only when attendance has already
been marked. No new write path, no fabricated denominator.

Rejected for v1: making the name pick write a `meeting_attendance` row. It would
give a real denominator and fill in attendance for free — genuinely valuable,
since the Sergeant does that by hand today — but it is a public unauthenticated
write into a table that carries meaning, and anyone could mark anyone present.
Revisit once the voting loop is proven.

## Server modules

New `src/server/voting.ts` (createServerFns and types only) plus
`src/server/voting-logic.ts` (all db access), per the split
`server-modules.guard.test.ts` already enforces — so `#/db` and `pg` never reach
the client bundle.

| function | access |
| --- | --- |
| `getBallot({ meetingId })` | public — open sessions + candidate names |
| `castVote({ meetingId, category, voter, candidate })` | public — upsert |
| `getVoteParticipation({ meetingId })` | public — how many ballots are in, never per-candidate counts |
| `getVoteTally({ meetingId })` | Ballot Counter / admin |
| `openVote` / `closeVote` | Ballot Counter / admin |

### The meeting lock cuts across this, and not uniformly

`completed` is the lock status (`isMeetingLocked` in
`src/lib/meeting-lifecycle.ts`), and completing the meeting is also what
force-closes voting. Applying `assertMeetingNotLocked` uniformly would therefore
break the feature in three separate places, so it is applied deliberately:

- **`openVote` and `castVote` assert the lock.** A completed meeting takes no
  new ballots and opens no new votes.
- **`closeVote` asserts the lock.** On a completed meeting everything is already
  closed, so there is nothing for it to do.
- **`getBallot`, `getVoteParticipation` and `getVoteTally` never assert.** They
  are reads. A completed meeting must still render "voting closed" to a phone
  left open, and the Ballot Counter must still be able to see the final tally.
- **Auto-close is a direct `UPDATE ... SET closed_at = now() WHERE closed_at IS
  NULL`** inside the completion transaction — never a call to `closeVote`, which
  would throw on the very status change that triggers it.
- **`resolveVoteCounterAuthz` does not assert the lock**, unlike
  `resolveWordOfTheDayAuthz`. Each mutating function calls
  `assertMeetingNotLocked` itself. This mirrors `setAward`, which is
  deliberately unlocked because minutes are written up after the meeting — and
  it is what lets the Ballot Counter set the winner from the final tally once
  the meeting is already completed.

## Integrity

Five things the server must not trust the client for.

1. **Candidate validity.** The candidate is re-derived server-side and the vote
   rejected if it is not in the eligible set. A hand-crafted POST cannot vote
   for someone who never spoke.

   The derivation is extracted out of `loadMinutes` into a shared
   `loadAwardCandidates`, read by **both** the ballot and this validator.
   `loadMinutes` keeps its existing id-only `awardEligible` shape by mapping
   from it. Two copies of this rule would eventually disagree, and the failure
   would be a ballot offering a candidate the server rejects — visible only
   mid-meeting. It also cannot be called from a public route in its old form:
   `loadMinutes` loads attendance, action items and guest contact details.
2. **Voter scope.** `voter_member_id` must belong to the meeting's club;
   `voter_guest_id` likewise. Reuse `requireMemberInMeetingClub`, the helper
   `setAward` already calls, rather than inventing a second scoping path. Scope
   guards are nets, not proofs — a join condition once satisfied the predicate
   rule while scoping nothing — so this also gets a **two-club integration
   test**, written first, not a guard test alone.
3. **The close/cast race.** Reading `closed_at` and then inserting lets a vote
   land after the vote closed. The insert is conditional in a single statement
   (`INSERT ... SELECT ... WHERE closed_at IS NULL`) so the window check and the
   write are atomic.
4. **Guest self-add is the abuse surface.** The public ballot can create guest
   rows, the same exposure the guest book already carries. v1 caps
   guests-per-meeting and caps the submitted name by **code-point count** — and
   does nothing clever with truncation on render, because the truncation added
   to close a DoS in #522 *was* a DoS for astral characters.
5. **Auto-close is transactional.** Completing the meeting closes open sessions
   in the same transaction as the status change, or a vote slips through the
   gap.

## Error handling

- A failed cast on bad conference wifi keeps the selection and shows
  "couldn't send — tap to retry". No optimistic-only UI that silently drops a
  vote.
- Re-opening a closed vote is `ON CONFLICT DO UPDATE SET closed_at = NULL`, not
  a second row.
- A guest deleted mid-meeting cascades their votes away. A removed member's
  votes survive with a null candidate and are dropped from the tally.
- Meeting-key resolution keeps the existing behaviour, including the non-RFC
  uuid rejection.

## Testing

Integration tests in `src/server/voting.integration.test.ts`, run with
`TEST_DATABASE_URL` set — bare `bun run test` silently skips the integration
suite and still reads green.

- one vote per person per category, enforced at the database rather than in code
- re-vote while open replaces the pick
- cast after close rejected, including the concurrent close/cast race
- candidate outside `awardEligible` rejected
- a guest votes; a guest wins
- `vote_counter` self-assert grants; a plain member is denied; a **renamed**
  `vote_counter` still grants
- completing the meeting closes open sessions — and completing it a second time
  (or completing one with no votes at all) does not throw
- the tally is still readable on a completed meeting, and `setAward` from that
  tally still works once the meeting is locked
- the tally returns counts only, never voter → candidate rows
- **two clubs**, per integrity point 2

Plus:

- `voting-authz.guard.test.ts`, following `outreach-authz.guard.test.ts`.
- A no-PII-on-the-ballot-payload guard, following
  `public-meeting-contact.guard.test.ts`.
- The print page-count gate, re-run for the agenda QR.
- `server-modules.guard.test.ts` covers the `voting.ts` / `voting-logic.ts`
  split for free.

**Verification discipline.** The closed-window check and the club-scoping check
are verified by breaking the code and watching the test fail, not by logging.
Vitest swallows `console.error` in this repo, which has previously made a live
branch look dead.

## Out of scope

- Digital comments — the other half of #510, still unshaped.
- Paper ballots entered into the digital tally.
- Blocking self-votes.
- Name-pick writing attendance.
- Any realtime transport.
