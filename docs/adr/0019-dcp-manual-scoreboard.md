# ADR-0019: Distinguished Club Program — a manual scoreboard, catalog in code

Status: Accepted (§1's "the **only** auto-derivation" is now three assists, and §3's
composite-goal note is extended — see the Amendment below before trusting either)

## Context

The President office (`officer_terms` position `president`, resolving to club `admin` via
effective-admin) had no dedicated feature — it maps mostly to existing surfaces (club settings,
roster). The one genuinely President-owned job with nothing like it is tracking the club's
**Distinguished Club Program (DCP)** progress: 10 standardized Toastmasters goals across a program
year (Jul 1 – Jun 30), driving recognition as Distinguished / Select / President's Distinguished.

Issue #207 asks for a DCP goal tracker. The load-bearing question raised in triage was the
**auto-derive vs. manual-scoreboard boundary**: which of the 10 goals GavelUp computes from
existing data vs. which the President enters by hand.

Investigation settled it. The six **education** goals (levels completed) cannot be reliably
auto-derived from the Pathways model today: `path_level_progress` stores only current-state counts
(`level`, `completed`, `total`, `approved`) with **no completion date** and **no club
attribution**, so an approved level can't be scoped to a program year or credited to a club — the
two facts DCP education goals require. Pathways data also only exists for clubs that run the Base
Camp sync extension. By contrast the two **membership** goals (new members) are cleanly derivable
from `members.joined_at`.

## Decision

### 1. v1 is a manual scoreboard, with a roster-derived assist only on the membership goals

The President enters/toggles every goal by hand. The **only** auto-derivation is a roster-based
pre-fill of the two new-member goals (7 & 8) plus the membership-base number. Education-goal
auto-derivation is deferred to #245, gated on a Pathways sync/schema change to date-stamp and
club-attribute level completions. This ships the President-owned value now without a speculative
schema commitment, and degrades gracefully for clubs that never sync Base Camp.

### 2. The goal catalog is static code; only progress is stored

The 10 DCP goals (labels, categories, targets) are standardized by Toastmasters International and
stable year-to-year, so they live as a static catalog in `src/lib/dcp.ts` — not a table. Only
per-club **progress** is persisted:

- **`dcp_scoreboards`** — parent, one row per `(club_id, program_year)` (unique). Holds
  `base_member_count`, **auto-snapshotted** to the current active-member count when the scoreboard
  is first started and **President-editable** thereafter (so a club adopting mid-year can correct
  it). `program_year` is the starting calendar year.
- **`dcp_goal_progress`** — one row per `(scoreboard_id, goal_key)` (unique), storing an integer
  `achieved` and an audit `updated_by` / `updated_at`. `goal_key` is plain text matching a
  `DCP_GOALS[].key`, keeping the code catalog the single source of truth (no goal enum).

### 3. Uniform per-goal model; tier and base are derived, never stored

Every goal has a catalog `target`; `met = achieved ≥ target`. Count goals (1–8) store the count;
composite goals (9 training, 10 administration) are scored by TI as a single met/not, so they are
`target = 1` with a 0/1 toggle. The **recognition tier** and **membership base** are computed at
read time (`src/lib/dcp.ts`), never stored:

- Base met = `current_active ≥ 20` **OR** (`base_member_count` set AND
  `current_active − base_member_count ≥ 5`). The net-+5 baseline must be stored because roster
  history can't reconstruct "who was active on Jul 1" (`members.status` is current-only).
- Tier (only if base met): ≥9 → President's Distinguished · ≥7 → Select · ≥5 → Distinguished.

### 4. Admin-gated surface, reusing existing authz

The scoreboard lives at an admin-gated route (`_authed/admin/dcp`), mirroring the Treasurer's
`_authed/admin/dues`. View + edit are gated on club `admin` (`requireClubRole(["admin"])`); the
President defaults to admin, so no officer-position-based authz is introduced. Admin-only in v1 —
a read-only/motivational member view can come later. The DB logic lives in `dcp-logic.ts` (the
server-fn module `dcp.ts` exports only `createServerFn`s + types, per the server-module bundle
rule) and the tier/base/catalog math is the pure, client-safe `#/lib/dcp`.

## Consequences

- Ships the President's DCP tracker with no dependency on the Pathways model or a background job.
- Education goals are hand-entered until #245 lands the completion-dating/attribution change.
- New tables `dcp_scoreboards` / `dcp_goal_progress`; the catalog stays in code, so a future TI
  rule change is a code edit, not a migration.
- The membership base's net-+5 path depends on the snapshotted baseline; a club that starts its
  scoreboard well after Jul 1 must correct `base_member_count` by hand.

## Amendment — goal 9 gains a record behind it (#531, third assist)

Status: Accepted. Extends §1's assist boundary and §3's composite-goal note. Nothing in the
original decision is reversed: goal 9 remains a President-entered composite 0/1 in
`dcp_goal_progress`, and the recognition tier and membership base remain derived at read time.

### What §3 got right, and what it left the club unable to see

"Composite goals (9 training, 10 administration) are scored by Toastmasters as a single met/not,
so they are `target = 1` with a 0/1 toggle" is a correct statement about SCORING, and it was
silently read as a statement about STORAGE. Goal 9 held nothing but the toggle, so the scoreboard
could not answer any of: which officers were trained, which of the two training periods they were
trained in, how many more the club needs, or how long the window is open. The toggle holds no
information until someone already knows the answer — which is the state #531 was filed against: a
club discovers in March that only three officers were trained in the second window, the window is
shut, and a DCP point is gone.

### Decision

Two new tables sit BESIDE `dcp_goal_progress` and feed goal 9 an editable **suggestion**. They do
not change how it is stored or scored.

- **`officer_training_records`** — one row per `(membership, office, program_year, period)`. Keyed
  on the membership and the office rather than on an `officer_terms.id`, because a term row closes
  and reopens on re-election while training credit does not: a record must survive its officer's
  term ending mid-window. `trained_on` is nullable and the score never reads it.
- **`officer_training_periods`** — a SPARSE override of the two window date ranges, scoped to
  `(club, program_year)`. Toastmasters sets the windows itself (Jun 1 – Aug 31; Nov 1 –
  Feb 28/29) so those are the defaults, derived in code: **row absent = TI's window**. Editable
  because a district may deviate, and because only a real date range makes a deadline honest.
  Scoped to the club-year rather than to `dcp_scoreboards.id` so the windows are readable before a
  scoreboard exists — which is precisely when the deadline reading is worth having.

**The bar counts distinct trainable OFFICES with at least one record.** TI words goal 9 over
roles — "a minimum of four club officer roles trained" — and adds "credit is given only for one
person per officer role". Both halves point at the same unit, so counting distinct offices is a
transcription of the rule rather than an approximation of it.

This took two corrections to reach, and both are worth recording because the reasoning generalises.

The instruction (2026-09-04) was to count distinct PEOPLE, justified as the conservative reading
that "can only under-count relative to TI". Review found that false in one direction: **two people
recorded against one office is 1 role to TI and 2 to a people count** — over-counting, exactly what
the conservative reading exists to prevent, and reachable rather than theoretical (the unique index
is `(membership, office, year, period)`, and the panel offers all seven offices to any active member
deliberately, since someone may have been trained for an office they have since handed on). Four
members against one office displayed "4/4 · Bar cleared" and suggested goal 9 MET.

The first fix kept people as a second ceiling, `Math.min(people, offices)`. That closed the
over-count but kept a ceiling with no basis in TI's rule, and such a ceiling can only subtract:

| Shape | TI credits | distinct offices | min(people, offices) |
|---|---|---|---|
| 4 people, 4 offices | 4 | 4 | 4 |
| 4 people, all Secretary | 1 | 1 | 1 |
| 1 person, 2 offices | 2 | 2 | **1** |
| 2 people, 4 offices | 4 | 4 | **2** |

Both shapes it gets wrong are the double-hatting small club — President also VP Education,
Secretary also Treasurer — which is normal below about fifteen members and describes the club this
was built for. Counting offices alone satisfies the original guarantee outright, because it IS TI's
rule; there is nothing left to be conservative about.

Two limits stay, recorded rather than fixed. The count does not verify that the person held the
office recorded against them, which TI requires ("Officers must be trained for the position to
which they were elected") — deliberate, because a record must survive its officer's term ending
mid-window and the club's claim is the club's to make. And display is keyed on
`(membership, office)` rather than on the office alone, so a dual-office holder trained for one of
their two reads as done on that seat and open on the other.

**The panel's program year is not `currentProgramYear()`.** That rolls on Jul 1; period 1 opens
Jun 1 of the year it belongs to. For the whole of June the open window therefore belongs to the
NEXT program year, and pinning the panel to the current one showed both windows shut in the one
month incoming officers are trained — with June entries filed against the previous year's
already-scored goal 9. `trainingProgramYearForDate` names the right year and the picker offers it;
June is the only month the two disagree.

`immediate_past_president` is excluded — TI names seven elected offices and IPP is not among them.

**Assist, never a write.** This is the third assist, alongside the roster assist (goals 7 & 8) and
the Pathways assist (goals 1–6, #245), and it follows their pattern exactly rather than inventing a
fourth: the suggestion is computed on every read, stored nowhere, and written only by an explicit
`applyTrainingSuggestion`. That routes through `updateGoal`, so the composite 0/1 clamp and the
audit stamp keep one owner. TI, not GavelUp, is the system of record for who was trained — a club
must never be told it missed a point because someone forgot to tick a box here.

### Consequences

- §1's "the **only** auto-derivation is a roster-based pre-fill" is now three assists, all of them
  suggestions. The no-silent-write rule is what makes them uniform.
- The apply CAN write a 0, clearing a hand-entered Met. Guarded upstream, not in the seam: the
  action is offered only once the club has recorded something, and the button names the value it
  will write.
- Goal 10 (administration) keeps its bare toggle. Dues renewal and officer-list submission happen
  on TI's site with no local record to derive from, so there is nothing to put behind it.
- A window-closing notification is now buildable (ADR-0023's poller needs only an INSERT) and is
  deliberately NOT built here: the panel shows the countdown, and a nudge is its own change.
- The counting rule sits in `src/lib/officer-training.ts` rather than in a `-logic.ts` module,
  because the substance of this change is a set of numbers and a constant inside a `#/db`-importing
  module cannot be asserted by a unit test at all.
