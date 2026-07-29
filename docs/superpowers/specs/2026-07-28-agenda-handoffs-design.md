# Agenda hand-offs: say who introduces whom

Closes the audit half of #363 and acts on it.

## Why

Running live meetings off the generated agenda surfaced gaps one at a time, in
front of the club (#351, #352, #353, #354, #358). #363 asked for the diff to be
done deliberately instead: take the club's existing printed agenda and walk it
against `RUN_OF_SHOW`, the four print layouts, and `buildSlideDeck`.

The source document is MCF's printed agenda for meeting 55 (7/09/2026), a club
that runs the `geIntroducesFunctionaries: true` variant. Diffing it produced one
dominant theme, which is the scope of this change: **the generated agenda never
says who hands off to whom.** Segments simply follow each other, so at the front
of the room nobody knows whose cue it is.

## The audit

### Hand-offs the old agenda states and we do not emit

| | Old agenda | We emit today |
|---|---|---|
| A | Sergeant-at-Arms **introduces the President** | Two adjacent rows, no stated hand-off |
| B | **Toastmaster introduces the General Evaluator** (own row, 6:48) | The GE simply appears at beat 4 |
| B2 | **Toastmaster introduces the Table Topics Master** | The Table Topics Master simply appears |
| C | **Table Topics Master introduces the General Evaluator** (own row, 7:21) | Nothing — votes, then evaluators appear |
| D | **General Evaluator introduces the Speech Evaluator(s)** | Evaluator rows with no introducer |
| E | GE **returns control to the Toastmaster** | Nothing between the overall evaluation and the awards |
| F | Toastmaster **concludes, transitions to the President** | Nothing between the awards and club business |
| G | The segment leader **calls for the Timer's report and the vote** | `who: "Timer"` — reads as though the Timer runs the vote |

G is the one that bites live: the row names the Timer, so the person who is
actually supposed to ask for the report has no cue.

### Things we emit that MCF does not do

| | We emit | MCF |
|---|---|---|
| L | "Call to Order · phones silent, **exits noted**" | Phones only |
| M | "Club business · **elections** · adjourn" | Announcements; elections are not a standing item |

### Deferred to follow-up issues

Filed against #363, deliberately out of scope here:

- **J** — the old agenda spells out what each functionary says (Grammarian gives
  the Word of the Day *and its usage*, Ah-Counter counts filler words, Timer
  states the limits). Ours says a generic "each explains their role".
- **K** — MCF runs announcements → guest comments → adjourn; we run guest
  comments → club business.
- **H** — the old agenda prints the Table Topics limits ("1 min min, 2.3 min
  max, 2.31+ disqualified"). Our run sheet prints none and the deck says
  "1–2 minutes per speaker", which contradicts it. Needs per-club fields.
- **Rename inconsistency** — a club that renames a role sees BOTH names on one
  printed page. `expandRunSheet` labels every run-sheet row with the beat's
  canonical `owner.roleName` (`:836`, `:849`, `:864`, `:873`), while
  `buildLegend` (`:288`) and `ROLES_TOKEN` (`:741`) use the slot's own
  `s.roleName`. So renaming "General Evaluator" to "Chief Evaluator" gives
  "Chief Evaluator" in the roles table and in beat 4's functionary list, and
  "General Evaluator" on every row. Pre-existing and not introduced here, but it
  is the same who-leads confusion this change exists to remove, and #368's
  key-binding was specifically meant to make renames safe. Deferred because the
  fix touches every role beat and flips a pinned #368 test — its own decision.
- **Role-description drift** — `ROLE_TEMPLATE` descriptions, rendered on the
  role sheets, disagree with the run-of-show this change makes explicit: the
  Table Topics Master's says nothing about calling the vote or introducing the
  GE; the General Evaluator's never mentions introducing the evaluators; the
  Timer's says they report "at the end of the meeting" when we now print three
  reports to three different leaders. Deferred because the descriptions are
  per-club editable rows, so fixing them needs a backfill policy that cannot
  clobber a club's own edits — its own decision, not a rider on this one.

## Scope

Hand-offs A–F, B2 and G, plus the L/M wording. Applies to **all clubs**, with
owners adapting to the club's configuration; only B is variant-specific, since a
standard-flow club has no early GE appearance to introduce.

## The resulting agenda (MCF variant)

New rows `+`, changed `~`. Hand-off rows book **0 minutes**.

```
 1min  Sergeant-at-Arms          Call to Order · phones silent ·           ~A,L
                                   introduces the President
 1min  President                 Opening remarks; welcomes guests
 3min  Toastmaster · Faisal      Opens meeting · introduces the theme
 0min  Toastmaster · Faisal      Introduces the General Evaluator          +B (MCF only)
 3min  Gen. Evaluator · Riyaz    Introduces the Grammarian, Ah-Counter,
                                   Timer & Vote Counter; each explains
                                   their role
 0min  Toastmaster · Faisal      Introduces the speakers                   ~ (was 1min)
 5-7   Speaker 1 · Jagpal        "Leadership in the Era of AI" · Level 2
 4-6   Speaker 2 · Farhanaaz     "The Trust We Carry" · Level 1
 1min  Toastmaster · Faisal      Calls for the Timer's report ·            ~G
                                   vote Best Speaker
 0min  Toastmaster · Faisal      Introduces the Table Topics Master        +B2
 flex  Table Topics M. · Rasheed Impromptu topics using the Word of the Day
 1min  Table Topics M. · Rasheed Calls for the Timer's report ·            ~G
                                   vote Best Table Topics
 0min  Table Topics M. · Rasheed Introduces the General Evaluator          +C
 0min  Gen. Evaluator · Riyaz    Introduces the speech evaluators          +D
 3min  Evaluator 1 · Sudheer     Evaluates Jagpal Singh
 3min  Evaluator 2 · Schinthia   Evaluates Farhanaaz Begum
 1min  Gen. Evaluator · Riyaz    Calls for the Timer's report ·            ~G
                                   vote Best Evaluator
 2min  Gen. Evaluator · Riyaz    Evaluates the evaluators
 3min  Gen. Evaluator · Riyaz    Calls for the functionary reports
 2min  Gen. Evaluator · Riyaz    Overall meeting evaluation ·              ~E
                                   returns control to the Toastmaster
 2min  Toastmaster · Faisal      Awards · Best Table Topic, Best           ~F
                                   Evaluator & Best Speaker ·
                                   hands over to the President
 2min  President                 Guest Comments
 3min  President                 Club business · announcements · adjourn   ~M
```

Net clock change: **−1 minute for MCF-variant clubs**, because the existing
"Introduces the speakers" row drops from 1 minute to 0. **Zero for standard-flow
clubs**, which never had that row and gain it at 0 minutes. Every other new row
is 0 minutes and every other change is wording, so no club's agenda grows.

### Rows versus trailing clauses

The source document is itself mixed, and we follow it rather than normalising:

- **B, B2, C, D get their own rows.** On the scan, 6:48 and 7:21 are literally
  standalone transition rows.
- **A, E, F are trailing clauses** on an existing row. On the scan, "Returns
  Control to the Toastmaster" is a bold line at the foot of the GE's 7:30–7:35
  block, not a row of its own; likewise "Transitions to the President" under the
  awards, and "Introducing the President" under the Call to Order.

### Why hand-offs book 0 minutes

The time is already budgeted. The Toastmaster's 3-minute opening has always
included introducing the General Evaluator — the new row names the act, it does
not add one. Booking each hand-off separately would double-count and make every
generated agenda roughly five minutes longer than the meeting it describes.

The source document hedges on this (6:48 → 6:49 gives the first transition a
minute; 7:21 → 7:21 gives the second one nothing), so it does not settle the
question either way.

## Design

### Hand-offs are ordinary role beats

No new beat kind. A hand-off is `kind: "role"` with `minutes: 0`.
`buildTimeline` already advances `cursor += 0` and `applyFlex` already sums
`minutes`, so neither the clock nor the flex remainder needs arithmetic changes.
This is what #438's handback beat already is; we are generalising it.

A hand-off's `requiresAnyOf` gates on the **target** of the introduction, never
on its owner: a row must never promise a segment the club does not run.

`"Introduces the speakers"` (#438) becomes universal and drops to 0 minutes.
#438 reasoned that the standard flow needs no such row because the Toastmaster
is already holding the room — but B2 adds a row on exactly that reasoning, so
being explicit in both flows is the consistent choice.

### `fallback` generalises and moves to the shared part of `Beat`

Today `fallback` sits on the `event` variant as `{ roleKey, who, detail }`, and
its only three users are the vote beats — which become role beats here. Reshape
it and lift it to the shared part:

```ts
/** An alternative owner/detail used when `unless` has no slots this meeting. */
type BeatFallback = {
	/** The role whose ABSENCE triggers the fallback. */
	unless: BeatRole;
	/** Owning role for the fallback row; omitted ⇒ keep the beat's own owner. */
	owner?: BeatRole;
	/** Detail for the fallback row; omitted ⇒ keep the beat's own detail. */
	detail?: string;
};
```

One mechanism covers both jobs:

- `{ unless: TIMER, detail: "Vote Best Speaker" }` drops the Timer clause at a
  club with no Timer — exactly today's behaviour.
- `{ unless: TABLE_TOPICS_MASTER, owner: TOASTMASTER }` is how hand-off C adapts
  when there is no Table Topics segment: the Toastmaster is still holding the
  room, so the Toastmaster introduces the GE rather than the row vanishing and
  reintroducing the confusion for that club.

Hand-off D takes `{ unless: GENERAL_EVALUATOR, owner: TOASTMASTER }` on the same
principle.

This also deletes the last bare `"Toastmaster"` strings in the file, which name
a role that does not exist (the role is "Toastmaster of the Day") and do not
follow a club rename.

### The vote beats become role beats

`event` → `role`, owned by the segment leader: Toastmaster after the speeches,
Table Topics Master after Table Topics, General Evaluator after the evaluations.
Gating on the segment is unchanged. Plus one new flag:

```ts
/** Render even when the owning role has no slot this meeting, as the bare role
 *  name with no assignee. */
renderUnowned?: true;
```

Needed because a plain role beat with no owner slot is omitted today.
`role_definitions.enabled` is real — a skeleton-crew club can switch off
Toastmaster of the Day — and without this flag such a club would lose the
Best-Speaker vote from the printed agenda while `buildSlideDeck` still projects
the `voteSpeaker` slide. Print and deck disagreeing is the failure #371 exists to
prevent.

The Timer stops owning a row. That matches the source document, where the
Timer's report is a line inside the leader's block, never a row.

### The awards beat becomes role-bound

Owned by Toastmaster of the Day with `renderUnowned: true`, so it shows the
holder's name and matches every other leader row. It is otherwise the only
leader row without a name, at the moment someone has to stand up and hand out
ribbons. It also stops naming a role that does not exist: the bare string was
`"Toastmaster"`, while the role is "Toastmaster of the Day".

It does **not** make the row follow a club rename — an earlier draft of this
spec claimed it would, which was wrong. No role row does: `expandRunSheet`
labels every row with the beat's canonical `owner.roleName`. See the
rename-inconsistency follow-up below.

### Print: hand-off rows render as a compact band

`AgendaRow` gains `handoff?: true`. The four print layouts render those rows as
a thin single-line band — no repeated clock stamp, tighter padding, muted weight
— rather than a full block. The band still carries the holder's name, rendering
`{who} · {detail}` on one line, so the beat's `detail` needs no special casing:

```
7:20 │ Table Topics Master · Rasheed Bustamam
     │   Calls for the Timer's report · vote Best Table Topics
     ↳ Table Topics Master · Rasheed Bustamam · Introduces the General Evaluator
     ↳ General Evaluator · Riyaz Mohammed · Introduces the speech evaluators
7:21 │ Evaluator 1 · Sudheer Isanaka
     │   Evaluates Jagpal Singh
```

Without this, two consecutive rows stamped 7:21 render as identical-weight
blocks and read as a duplicate, and MCF gains four full blocks on layouts that
include one-pagers.

Row keys are currently `` `${r.time}-${r.who}` ``, which stops being unique once
adjacent rows can share a start time. Fold the index in.

### Deck: full parity

`buildSlideDeck` gains a `handoff` slide kind, flowing through the shared
`slide-layout.ts` descriptor into both the present view and the PPTX export
(`deck-to-pptx.ts`). Every hand-off row gets a slide, so the leader has the cue
on screen at the moment they need it.

The three vote slides gain `caller: LegendEntry | null`, so the projector names
the same person the run sheet does.

A, E and F are trailing clauses rather than rows and get no slides — the SAA and
President beats project nothing today either.

## Testing

- `agenda-runsheet.test.ts` — hand-off beats in both flows; 0-minute rows leave
  the timeline and `applyFlex` unchanged; each `fallback` branch (no Timer, no
  Table Topics Master, no General Evaluator); `renderUnowned` on a club with no
  Toastmaster of the Day.
- `agenda-parity.test.ts` — the print↔deck contract, now including hand-offs and
  the vote `caller`.
- `agenda-slides.test.ts`, `slide-layout.test.ts`, `deck-to-pptx.test.ts` — the
  new slide kind through all three consumers.
- `meeting-agenda-print.test.tsx` — band rendering and unique row keys.

## Accepted trade-offs

**A leadership role with two slots duplicates its rows.** `expandRunSheet`'s
plain-role branch emits one row per matching slot, while the deck takes
`slots[0]`. A club that sets `defaultCount: 2` on Table Topics Master (the admin
form allows 0–20 for any role) or adds a second slot via `addRoleSlot` would
print "Calls for the Timer's report" twice. This divergence already exists for
beat 4 and is not introduced here, only widened. Deliberately not fixed: it
requires a club to configure something no club does, and the fix (collapsing
leadership beats to one row) is a behaviour change of its own.

**Standard-flow clubs' agendas change too.** Hand-offs A, B2, C, D, E, F and the
vote-owner change apply to every club, not just MCF. This is intended — the
who-leads confusion is not MCF-specific — but it means clubs that did not ask
for it will see their printed agenda change.

**The grid layout now has zero print headroom.** Measured in a browser on a
23-row MCF agenda: the grid page's inner height is 1108px against a 1056px
budget, so `FitPage` scales it to 0.951. Before the hand-off rows it was 1019px
and fitted exactly. The compact band already halves the cost — as full rows it
would be 1174px, a 10% shrink — and getting back under budget would need a
~7.4px band, which is not a legible line. So the overshoot is those five rows
existing, which is the point of the change, and a 5% auto-scale is the right
price: nothing clips, and grid body text lands at ~7.5pt.

What this costs is headroom. Grid is the DEFAULT print layout, and it is now
52px over budget, so every future addition compounds into a deeper scale. **The
next content change to the grid layout must arrive with a compensating
reduction.** The cheap inventory, if it is ever needed: ~16px of pure whitespace
across three section gaps and the footer margin, plus ~10px from halving the
band's padding. Beyond that it means re-tuning the row rhythm.

(The editorial layout measures 1349px and was already over budget before this
work — ~1251px without hand-offs. Pre-existing, not caused here.)
