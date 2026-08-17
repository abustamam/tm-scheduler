# Planned-attendance rail polish

**Date:** 2026-08-17
**Surface:** `src/components/club/meeting-attendance-panel.tsx` (the officer/TMOD rail on
`/club/:clubId/meeting/:key`), shipped in v1.15.0.0 (#575) and extended by #576.
**Status:** design approved, not yet implemented.

## Problem

Dogfooding the rail against a real club surfaced seven complaints, all in one component:

1. A long name truncates with no way to read it.
2. The rows are cramped.
3. The status control is vertically centred against a two-line block, so nothing shares a
   baseline and the column reads crooked.
4. A member whose role slot is **confirmed** still sits in the "no answer" bucket, so the
   officer chases someone who has already committed.
5. Outreach ignores the role. A member holding Toastmaster gets "are you able to make our
   meeting?" when the slot cards two feet away send "just confirming you're our Toastmaster".
6. The `WhatsApp` / `Email` buttons spend most of a 340px rail on two words that a glyph says.
7. The unset status control renders `—`, which reads as a deletion rather than an invitation.

## Non-goals

- No change to `meeting_attendance_plan`, its enum, or `attendance-plan-logic.ts`.
- No change to the payload shape or to any server fn. Everything here is derivable on the
  client from data the meeting payload already ships.
- No change to how the rail collapses below `lg` (#575's `matchMedia` subscription stands).
- No change to the agenda slot cards or the recruit picker, which share `NudgeButtons`.

## Design

### 1. Status precedence — the one new rule

Lives in `buildPlanPanel` (`src/lib/attendance-panel.ts`), which is pure, so the rule is
assertable directly rather than through a rendered DOM.

```
explicit coming / not_coming   →  that answer            (the member's own word always wins)
role slot status = confirmed   →  "Coming", assumed
stored reached_out             →  "Asked"
no row                         →  unset
```

**Why `confirmed` outranks `reached_out`, and why this ordering is load-bearing rather than
cosmetic.** A confirmed-role member has *no plan row at all*, so the assumed-Coming state is
invisible to the write path. `markAsked` (route line ~705) short-circuits only when a rung
already exists — a derived Coming is not a rung — so tapping that member's WhatsApp draft
inserts `reached_out`. `setPlanStatus`'s `demoteFrom: ["reached_out"]` guard does not help:
it is a `setWhere` on the conflict branch, and with no existing row there is no conflict, so
the INSERT lands. Without this precedence the officer confirms a Toastmaster, messages them,
and watches them fall from Coming back to Asked — the exact regression the feature exists to
prevent. Ordering it here fixes it with no write change, and keeps the `reached_out` row,
which is a true record of having messaged them and belongs in the activity log.

Consequences:

- Assumed-Coming counts toward `coming` in `countsLine` and sorts into the coming bucket
  (`RUNG_ORDER` rank 2). The maintainer's call: a confirmed role is safe to read as attending.
- Assumed-Coming renders **distinguishably** from an answered Coming — the role badge carries a
  check and the status control uses the muted variant with the accessible name
  "Coming — assumed, role confirmed". The officer must be able to tell an inference from an
  answer, or the rail is lying about who replied.
- The control stays a live menu, so an explicitly set `Not coming` overrides a confirmed role
  (a confirmed Toastmaster who drops out the night before).

### 2. Role badge — the sign-up sheet's abbreviation

`roleAbbrev` / `buildShortCodes` (`src/lib/agenda.ts`) already produce the season grid's codes,
already dedupe collisions, and already number repeats. They are pure and client-safe, and the
meeting payload's slots already carry `roleDefinitionId` and `slotIndex`, so the route calls
`buildShortCodes(slots)` directly. **No payload change, no server work, and the rail agrees with
the sign-up sheet by construction rather than by a second hand-maintained list.**

Yields `TD`, `GE`, `TTM`, `SP1`/`SP2`, `GRM`, `AC`, `TMR`.

The full role name is exposed via native `title` + `aria-label` on the badge — no new
dependency. Known limit, accepted: hover does not fire on touch, and the rail is run on a
tablet. Judged acceptable because these codes are the vocabulary the sign-up sheet already
teaches and the full role name is visible on the agenda in the same view. A Radix Tooltip would
add a dependency and still show nothing on tap, so it would buy hover polish only.

### 3. Row layout

```
Jennifer Yellowhorse   [✓TD]          ← identity line; name wraps, never truncates
                  ⌨  ✉   [ Coming ▾ ] ← action line; one right edge for every row
```

- Rows separated by a hairline divider, `py-2.5`.
- Name: full width of line 1, `break-words`, capped at 2 lines. **The `truncate` class comes
  off.** At 2–4 characters the badge no longer competes for the name's width.
- Action line: a single right-aligned cluster — WhatsApp icon, Email icon, status control — so
  every row shares one right edge. This is the alignment fix; nothing is vertically centred
  across a variable-height block any more.
- Unset status reads **`Ask ▾`**, naming the action the officer is about to take. Set states
  read `Asked` / `Coming` / `Not coming` as they do today.

### 4. Role-aware outreach

`NudgeButtons`' `mode` becomes a computed prop at the panel's call site:

- Member holds a slot → `mode="confirm"` with the slot's **base** `roleName` ("just confirming
  you're our Toastmaster…"), matching the agenda slot card exactly.
- No slot → `mode="attendance"` ("are you able to make our…"), unchanged.

Note the two different role strings: the badge shows the numbered short code (`SP1`) while the
message uses the base role name (`Speaker`). The agenda already draws this distinction —
`slotLabel` for display, `slot.roleName` for the draft.

Unlike the agenda's slot-card nudge, the panel keeps `onContacted`, so tapping a draft still
records `reached_out`.

### 5. `NudgeButtons` gains `iconOnly`

Default `false`. The agenda slot cards and the recruit picker are untouched; only the rail opts
in. Icon buttons carry `aria-label` (`Message <name> on WhatsApp` / `Email <name>`) and `title`,
because the visible text that was their accessible name is what is being removed.

## Plumbing

- Route (`club.$clubId.meeting.$meetingId.tsx`) builds a second map beside the existing
  `roleByMemberId`:
  `panelRoleByMemberId: Record<string, { code: string; roleName: string; confirmed: boolean }>`.
  The existing `roleByMemberId` is left alone — four other consumers read it
  (`meeting-agenda.tsx`, `assign-slot-sheet.tsx`, `nudge-recruit-picker.tsx`, `lib/agenda.ts`),
  and widening its value type to serve one of them is how a shared map becomes everyone's
  problem.
- `PanelMember.roleName: string | null` becomes
  `role: { code: string; roleName: string; confirmed: boolean } | null`.
- `buildPlanPanel` takes the new map and applies the precedence rule. Its returned rows carry an
  `assumed: boolean` so the component can style the inference without re-deriving it.

## Testing

Aimed at the traps this repo has actually hit (CLAUDE.md, Test Coverage).

**Pure — the load-bearing gate.** `src/lib/attendance-panel.test.ts`:

- The full precedence table: each of `{none, reached_out, coming, not_coming}` × `{no role,
  role unconfirmed, role confirmed}`. Twelve cases, one assertion each. In particular
  `reached_out` + confirmed role → Coming/assumed, which is finding 1 above.
- Assumed-Coming folds into the `coming` count and into `countsLine`.
- Assumed-Coming sorts into the coming bucket, not the `null` bucket.
- Explicit `not_coming` beats a confirmed role.

**Component.** `meeting-attendance-panel.test.tsx`:

- `mode` is a **computed** prop, which is the "a component tested through its props cannot see a
  WRONG prop" trap (#319). Asserting a WhatsApp button exists proves nothing about the mode. The
  test asserts the resulting `href` decodes to contain **"just confirming you're our
  Toastmaster"** for a role-holder and **"are you able to make our"** for a member with no slot.
- Icon buttons queried by accessible name.
- The badge renders the short code and carries the full role name as its `title`.
- Unset status control reads `Ask`, not `—`.
- An assumed-Coming row is distinguishable from an answered one (accessible name differs).

Exactly two existing tests break, both legitimately, and both are assertions the change is
meant to invalidate:

- `"shows the role a member holds"` (~line 91) passes `roleByMemberId: { m2: "Timer" }` and
  asserts `getByText("Timer")`. Both the prop shape and the rendered string change; it becomes
  the code `TMR` with `title="Timer"`. The `renderPanel` helper's prop plumbing changes with it.
- `"treats an override of null as cleared, not as absent"` (~line 109) asserts the status
  control's text `toContain("—")`. Becomes `"Ask"`.

`"offers a WhatsApp draft when a phone is on file"` (~line 85) does **not** break — it queries
`getAllByRole("link")` and the `No contact on file` text, both of which survive icon-only.
`nudge-buttons.test.tsx` is untouched because `iconOnly` defaults to `false`.

**Honest limitation.** jsdom performs no layout, so "the name wraps to 2 lines instead of
truncating" is not assertable in process, and this change is not worth standing up the headless
Chrome harness for. What *is* assertable, and what the test pins: the name element carries no
`truncate` class and the full name string is present in the DOM. Stated here so a later reader
does not mistake a green suite for proof of the geometry.

## Rollout

One PR off `origin/main`, branch `feat/attendance-rail-polish`, worktree
`/media/rasheed-bustamam/Extra/coding/tm-attendance-rail`. Diff is small enough that `/ship`
skips its specialists; run `/review` for the adversarial pass first per the repo's feature
pipeline order. MINOR bump — user-visible behaviour change (assumed attendance), not just
styling.
