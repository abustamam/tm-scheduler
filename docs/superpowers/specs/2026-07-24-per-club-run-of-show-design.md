# Per-club run-of-show — design

**Issue:** #367 (absorbs #353) · **Depends on:** #368 · **Date:** 2026-07-24

## Problem

The generated agenda hardcodes one club's conventions as if they were the Toastmasters standard.

At MCF the General Evaluator introduces the functionaries. That is unusual. In most clubs the
Toastmaster introduces the functionaries at the top of the meeting — each explaining their own role,
which is when the Grammarian gives the Word of the Day — and the General Evaluator's work happens at
the end: evaluate the evaluators, call for the functionary reports, then evaluate the meeting overall.

`RUN_OF_SHOW` (`src/lib/agenda-runsheet.ts:88`) encodes MCF's version, and its own comment already
concedes the point: *"The single hardcoded standard Toastmasters run-of-show for v1. … Per-club
configurable templates are a deferred issue."*

Two beats carry the assumption:

- `:112` — GE: `"Introduces evaluation team · Grammarian shares Word of the Day"`
- `:159` — GE: `"Grammarian, Ah-Counter & Timer reports · overall feedback"`

This is the root cause behind #352, #353 and #354 as well: each is a symptom of one club's running
order being the only one expressible.

Separately, a new club running a **skeleton crew** (Toastmaster, Speaker, Evaluator, Table Topics
Master) gets an agenda full of beats for roles it does not run.

## Goals

1. Correct the default template to the standard flow.
2. Let MCF keep its variant, since GavelUp should not force a live club to change how it meets.
3. Make the agenda adapt to the roles a club actually runs.
4. Keep the printed agenda and the projected deck from disagreeing.

## Non-goals

Explicitly out of scope, and deliberately so:

- **Per-club beat durations.** Hardcoded constants stay.
- **Arbitrary reordering or custom beats.** No template editor. If a club needs a joke-of-the-day
  segment, that is a future conversation, not this one.
- **A guest-comments toggle.** #352 adds the beat unconditionally; whether it is optional is that
  issue's problem, not this one's.
- **Freezing the template per meeting.** See "Accepted consequences".

## Design

### The insight that shapes everything

Adaptation needs no configuration input. Every enabled role has `defaultCount >= 1`
(`src/lib/role-template.ts`), so it generates at least one slot per meeting via `generateSlotRows`.
Once #368 stops generating slots for disabled roles, **slot existence is already the signal**:

| Role state | Slots on the meeting | Agenda |
| --- | --- | --- |
| Enabled, claimed | 1+, with an assignee | beat renders with the name |
| Enabled, unclaimed | 1+, no assignee | beat renders "— open —" (a sign-up prompt) |
| Disabled | none | beat omitted entirely |

The deck already works this way — `buildSlideDeck` gates its GE slides on
`byRoleName(slots, ...).length > 0` (`src/lib/agenda-slides.ts:162`). Deriving the run sheet from the
same signal makes print and deck consistent **by construction** rather than by agreement.

So the builder needs exactly one input:

```ts
buildRunOfShow({ geIntroducesFunctionaries }: RunOfShowConfig): Beat[]
```

Pure, no db, exhaustively unit-testable. It plugs into the seam that already exists:
`expandRunSheet(slots, template = RUN_OF_SHOW)` takes an injected template and both current callers
pass none.

### The corrected default template

| # | Who | Beat | Min |
| --- | --- | --- | --- |
| 1 | Sergeant-at-Arms | Call to Order · phones silent, exits noted | 1 |
| 2 | President | Opening remarks; welcomes guests | 1 |
| 3 | Toastmaster of the Day | Opens meeting · introduces the theme | 3 |
| **4** | **Toastmaster of the Day** | **Introduces the functionaries; each explains their role** — Grammarian gives the Word of the Day, Timer explains the signals, Ah-Counter explains what they count | **3** |
| 5 | Speaker(s) | Prepared speech | per speech |
| 6 | Timer | Timer's report · vote Best Speaker | 1 |
| 7 | Table Topics Master | Impromptu topics using the Word of the Day | 10 (flex) |
| 8 | Timer | Timer's report · vote Best Table Topics | 1 |
| 9 | Evaluator(s) | Evaluates a speaker | 3 each |
| 10 | Timer | Timer's report · vote Best Evaluator | 1 |
| **11** | **General Evaluator** | **Evaluates the evaluators** | **2** |
| **12** | **General Evaluator** | **Calls for the functionary reports** | **3** |
| **13** | **General Evaluator** | **Overall meeting evaluation** | **2** |
| 14 | Toastmaster | Awards · Best Table Topic, Evaluator & Speaker | 2 |
| 15 | President | Club business · elections · adjourn | 3 |

Bold rows are the change. Beat 4 replaces the GE's 5-minute intro beat; beats 11–13 replace the GE's
single 7-minute closing lump. Splitting 11–13 is what makes #353's report slide fall out naturally
rather than needing separate work — which is why #353 is absorbed here.

### The MCF variant

`clubs.ge_introduces_functionaries boolean not null default false`.

When `true`, **beat 4 only** changes owner: the General Evaluator introduces the functionaries
instead of the Toastmaster. MCF's closing sequence is the same evaluate → reports → overall as
everyone else's, so beats 11–13 are unaffected by the flag.

The toggle lives on the existing club settings page (`src/routes/_authed/admin/club-settings.tsx`),
alongside meeting length and reminder settings.

### Role adaptation

Derived from slots, per the table above. The one behavioral change in `expandRunSheet`: a plain-role
beat with **no matching slots is omitted**, where today it "degrades to a label-only row"
(`src/lib/agenda-runsheet.ts:262-269`). Enabled-but-unclaimed roles still have slots, so they keep
rendering as open — the distinction is between *nobody signed up yet* and *we do not run this*.

Consequences worth stating explicitly:

- **No General Evaluator** (a skeleton crew) → beats 11–13 all vanish, and nothing replaces the
  overall meeting evaluation. We do not reassign it to the Toastmaster: putting a beat in a club's
  agenda that they never configured is worse than omitting it.
- **No functionaries** → beats 4 and 12 vanish.
- **Some functionaries** → beat 4 names only the ones the club runs.
- **No Timer** → beats 6, 8 and 10 do **not** vanish. They become Toastmaster-run "vote Best X".
  The vote still happens; only the timer's report goes away. This is why adaptation has to be a
  builder rather than a filter over a static array.

### Deck parity

`buildSlideDeck` takes the same `RunOfShowConfig`. Its `geIntro` slide — literally MCF's convention
in slide form — becomes a Toastmaster-owned functionary slide under the standard flow, listing each
functionary and who holds it. MCF keeps the GE-owned variant behind the flag.

A **parity test** asserts the print run sheet and the deck agree on section order across the flag ×
role-set matrix. Adaptation cannot diverge (both read the same slots), but ordering still can, and
the parity test is what makes that fail in CI instead of on a projector mid-meeting.

`buildSlideDeck` would reach six positional parameters with the config added; fold them into an
options object as part of this work.

## Dependency: #368

#367's role adaptation cannot ship before #368, because **every new club is seeded with the same full
nine-role `ROLE_TEMPLATE`** — so "which roles exist" does not discriminate a skeleton crew from a
full club. Only an explicit enabled flag does.

#368 additionally gains an immutable **`key`** on `role_definitions` (`'general_evaluator'`,
`'grammarian'`, …), seeded from `ROLE_TEMPLATE`. Beats bind to keys instead of free-text names.

This matters because clubs can rename roles (`updateClubRole` accepts `name`), and
Toastmaster of the Day / Table Topics Master / General Evaluator are all `category: "leadership"` —
only the name distinguishes them. Today a renamed "General Evaluator" prints a ghost row. Under this
design it would mean *no enabled GE*, silently deleting beats 11–13. The design makes an existing
latent bug materially worse, so the fix belongs in the dependency that ships first. Custom roles a
club invents have no key and bind to no beat, which is correct.

## Rollout

Default `false` for everyone; MCF flipped to `true` by slug in the data migration.

The premise of this issue is that the current default is wrong for nearly every club. Other existing
clubs are presumably already running the standard flow in the room while GavelUp printed MCF's
version — so switching them makes the printout match what they already do.

## Accepted consequences

- **Past agendas reprint in the new order.** The run sheet is computed at render time and we do not
  snapshot it. Unlike a meeting number (#358) — an identifier read aloud and referenced later —
  nobody reprints last month's running order; the minutes are the historical record and the agenda
  is a forward-looking planning view. Freezing would cost a column, a freeze path, and carrying
  template variants forever so old snapshots still render.
- **Skeleton-crew clubs see a permanent "Agenda ends N min early" banner** until they set a realistic
  `lengthMinutes`. `applyFlex` stretches exactly one beat (Table Topics) and caps it at
  `TABLE_TOPICS_MAX`, so a four-role agenda cannot fill a 90-minute slot. The banner is accurate and
  is the prompt that gets the length corrected; suppressing it would hide a real mismatch. Consider
  rewording it to suggest adjusting the meeting length rather than trimming content.

## Testing

- `buildRunOfShow` — table-driven unit tests over the config × slot-set matrix.
- `expandRunSheet` — omission of no-slot plain-role beats; retention of unclaimed ones as open;
  the no-Timer reassignment of the vote beats.
- Parity test — run sheet and deck section order agree for every combination.
- Existing print and deck tests will need updating, since the default club now means the *corrected*
  default. **That diff is the useful review artifact** — it is the clearest statement of what changed.

## Sequencing

1. **#368** — enable/disable roles + the `key` column. Ships first, independently valuable.
2. **#367** — this spec. Absorbs and closes #353.
3. **#352** — guest comments beat, rebased onto the corrected template.
