# ADR-0026: An unverified picker may fill a blank; changing, clearing or ruling needs a session

Status: Accepted

Amends the trust model of ADR-0010 (TMOD self-serve editing), which called self-assert "interim …
when real per-member auth lands". Relates to ADR-0008 (Person vs Membership — the identity this
binds to), ADR-0016 / ADR-0020 (superadmin, impersonation), and #756 / #758 / #759 (the sign-in
binding this relies on). Decided in a grilling session on 2026-09-16 covering #699, #747, #752,
#574 and #754.

## Context

Every anonymous meeting surface in GavelUp works the same way. A member opens the club's public
link, picks their name out of "Who are you?", and writes: claims a role, answers "are you coming",
confirms, votes. There is no session anywhere in that flow. ADR-0010 named this the honour system
and made it safe with the activity log — every write records who it was attributed to, so a club
could tell afterwards.

The honour system's defence was always *after* the fact, and it assumed the only people holding
the link were the club. That assumption is what changed. A public meeting link is shared into a
WhatsApp group, pasted into an email thread, and printed on an agenda. **The adversary this
decision defends against is an outsider holding a link** — not a member behaving badly, which the
activity log already handles, and not a determined attacker, which nothing here would stop.

What an outsider holding a link could do before this decision:

- release every role on the agenda, one request at a time, hours before the meeting;
- mark the whole roster `not_coming` and free every role they held;
- reassign a speech to somebody else and unlink the speaker's project;
- change an already-cast vote.

None of that requires guessing anything. **Member ids are public identifiers, not credentials** —
they ship in the public sheet's own payload, because the sheet has to render the roster to let
somebody pick their name out of it. Treating one as proof of identity is treating a name badge as
a key, and this ADR says so explicitly because #574 asked whether member ids should be secret. They
should not be, and making them secret would not help: the roster is the feature.

Sign-in binding (#756/#758) now makes the other half possible. A magic-link session resolves to a
`Person`, and a `Person` to a membership in this club, so "prove you are this member" is a question
the server can finally answer. It refuses three cases (#759): a member with no email, a Person in
two or more clubs, and a shared address. Those users get a session with **no** membership.

## Decision

**An unverified picker may fill a blank. Anything that removes, overwrites or rules on somebody
needs a magic-link session bound to that member.**

"Fill a blank" is literal: write a value where there is currently none, in a way that takes nothing
away from anyone. Claiming an OPEN role fills a blank. Releasing a role someone holds does not.
Answering "coming" for the first time fills a blank. Changing that answer to "not coming" and
freeing the roles you held does not.

| Write | Unverified pick | Signed-in member |
|---|---|---|
| Claim an OPEN role for yourself | yes, unless your answer is `not_coming` | yes |
| First attendance answer | yes, never frees roles | yes |
| Change or clear an answer, free roles | no | yes (self, TMOD or officer arms) |
| Confirm a role you hold | yes, unless your answer is `not_coming` | yes |
| Release, reassign, edit speech details | no | any member of the club |
| First vote | yes | yes |
| Change a vote | only from the casting device | yes (member voters) |
| Role consoles | Phase 2 | Phase 2 |

"Blank" includes a row holding only `reached_out` (#762). That rung is the officer's record of
having ASKED, not a reply, so a member answering over it takes nothing away from anyone — the same
sentence `CLEARABLE_ASK` and `SELF_SERVICE_RUNGS` are already built on. It is not a nicety: the
officer's nudge draft INSERTS `reached_out` onto a blank row and the member answers from the
session-less personal meeting page, so counting the ask as an answer refuses the round trip the
ladder exists for. See the third consequence below for what that costs.

Two rows need their qualifier read carefully.

- **"unless your answer is `not_coming`"** is what stops the obvious hole in "filling a blank is
  harmless": an outsider who first marks a member `not_coming` and then claims roles in their name
  has filled two blanks and done real damage. A caller whose own recorded answer is `not_coming`
  is not filling a blank, they are contradicting a record, so the unverified arm closes.
- **"only from the casting device"** is the ballot's version of the same idea. A vote is not
  blank once cast, and the only unverified evidence that you are the person who cast it is that
  you are still on the device that did.

`resolveWriteActorWithProof` (`src/server/write-actor-logic.ts`) is the seam this rests on: it
returns `proof: "session"` when the member id came from the caller's own active membership in this
club, and `proof: "asserted"` when it came off the wire and was only club-scoped.
`requireSessionActor` beside it is the gate for the right-hand column, and refuses with one of two
distinct messages — "you need to be signed in" (offer the sign-in link) and "your account isn't
linked to this club's roster" (signing in again cannot help; ask an officer).

`write-proof.guard.test.ts` makes the classification a property of the tree rather than a memory:
every POST server fn needs a session gate or an entry in `WRITE_PROOF_EXCEPTIONS` saying which
class of debt it is.

## Consequences

- **The role consoles move to sessions in Phase 2, not now.** The TMOD, Grammarian, Timer and Vote
  Counter consoles each grant on a self-asserted role holder, and each is a person running a
  meeting from their phone with no time to check email. #747 and #752 own that migration; until
  they land, those 16 server fns are classified `console-asserted` and carry the same trust they
  have carried since ADR-0010. Recording them is the change — they were indistinguishable from
  genuinely-public intake before.
- **Members who cannot bind fall back to an officer.** No email on the roster, a Person in two or
  more clubs (#759), a shared family address: all three produce a session with no membership here,
  so every right-hand-column write refuses with `NOT_ON_ROSTER_MESSAGE`. That is a real cost, paid
  by real members, and it is why the message names the fix rather than saying "forbidden". The
  officer path — an admin acting on their behalf — stays open for all of it.
- **Member ids stay public, and are documented as public.** This answers #574. Nothing in this
  decision depends on a member id being hard to guess, so nothing degrades when one is shared. The
  corollary is a rule for future code: a member id off the wire is a *claim*, never an
  authorization, and `requireMemberInClub` (which validates only that the id is on this roster)
  must never be mistaken for a session check.
- **A member on a public link now sometimes has to sign in.** The honour-system sheet keeps
  working for the common case — arriving, picking your name, taking an open role — and asks for a
  session at the moments that used to be free. Every refusal carries a one-tap sign-in link back
  to the page it happened on, because a refusal with no route out of it is worse than the risk.
  `showWriteError` (`src/components/write-error-toast.ts`) is the one place that renders that, and
  a refusal surface that does not route through it shows a dead-end toast instead. **Two do not
  yet**, both wrapping `claimSlot` / `reassignSlot` / `releaseSlot`, all three `pending-proof`:
  `src/components/club/assign-slot-sheet.tsx` and `src/components/club/member-role-picker.tsx`.
  They were outside #761's cited files AND outside its own call-site inventory; whichever child
  flips those three writes converts them, because that is the change that makes their refusal
  reachable.
- **An outsider can now overwrite `reached_out` with an answer, for exactly the members an
  officer is chasing.** This is the one place the attendance child WIDENS what an unverified
  caller may do, and it follows from treating the ask as a blank (above) plus `setAvailability`'s
  deliberate absence of a `demoteFrom` — writing `not_coming` over `reached_out` is "they asked,
  the member answered", which is the ladder working. The set it applies to is not random: it is
  precisely the members an officer has contacted and not heard back from, and a forged
  `not_coming` there is indistinguishable from the reply the officer is waiting for. The trade is
  deliberate and it is the narrower one — the alternative refuses every nudged member their own
  answer — but it is a real widening, it is new relative to the rest of this decision, and it is
  recorded here rather than left as a property nobody wrote down. It closes with the role consoles
  in Phase 2, when `reached_out` stops being writable without a session at all.
- **A control that a session gates must not be SHOWN to a viewer without one.** The refusal being
  well-worded is not enough: a season grid that offers "Undo" on a toast that just said the write
  worked, or a personal page that asks "give up your role?" and then says "sign in", teaches that
  the product is broken rather than that the write is gated. So visibility and the gate are one
  decision — wherever a control's visibility keys on a member id while its handler keys on a
  session, the two conditions have to agree, and the client predicts the SERVER's answer per arm
  rather than a proxy for it. #762's review found six instances of the mismatch in one change,
  including one where predicting with a proxy silently dropped ADR-0016 admin parity for an
  impersonating superadmin. The state stays visible when the control goes; only the affordance
  is removed.
- **Nothing here is retroactive.** No grant changes when this ADR lands; #761 lays the seam, the
  refusal UX and the guard, and the Phase 1 children (slots, attendance, ballots, the role-card
  flag) each flip their own rows against the table above.
