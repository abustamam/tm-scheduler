# Meeting View Chrome Redesign (#541) — Spec

**Status:** grilled 2026-08-08 (7 decisions locked with maintainer, recorded on
[#541](https://github.com/abustamam/tm-scheduler/issues/541)); plan for PR 1 exists,
PR 2/3 plans are authored after their predecessor lands (see Delivery).
**Origin:** 2026-08-07 design audit findings F-002 (officer card density) and F-003
(toolbar sprawl); baseline screenshots in
`~/.gstack/projects/abustamam-tm-scheduler/designs/design-audit-20260807/`.

## Problem

The canonical meeting view (`/club/:clubId/meeting/:key`) serves three personas from
one page, and its chrome grew by accretion:

- **Toolbar:** 8+ equal-weight chips (share, print, present, role sheets ×2, word
  poster, .pptx, availability) — 5 rows on a 375px phone, ~25% of the first
  viewport, shown to guests before they have an identity. No primary action.
- **Officer role cards:** every card carries a vertical stack of 3–5 buttons
  (Reassign…, Nudge, Release, Confirm, Edit speech, ↑↓) — ~50 buttons per page,
  five identical filled "Confirm" CTAs, cards 3–4× taller than their content.
- **Minutes/attendance/awards render inline always**, making the officer page
  5,384px tall on mobile two weeks before the meeting.

The page's core interactions (claim flow, availability undo) audit extremely well —
the chrome around them is the problem. Chrome is re-weighted, never removed:
**every capability stays reachable in every phase.**

## Decisions (locked)

### D1 — Phase-aware chrome

Three phases drive *visual weight only* (never capability):

| Phase | Definition (club-local day granularity) |
|---|---|
| `completed` | `status === "completed"` (locked) OR scheduled day strictly past (`meetingDatePassed`) |
| `today` | scheduled day is today: `meetingDateReached && !meetingDatePassed`, not locked |
| `upcoming` | scheduled day is in the future |

Derivation reuses the existing helpers in `src/lib/meeting-lifecycle.ts`
(`isMeetingLocked`, `meetingDateReached`, `meetingDatePassed` — all club-timezone,
day-granular, injectable `now`). A passed-but-never-completed meeting is phase
`completed` (the officer's job there is recording what happened), while the
existing `resolveMeetingViewer` asymmetry (admins keep editing until they press
Complete) is untouched. `cancelled` meetings keep their current rendering; the
phase model does not special-case them.

**Timezone trap (pinned by tests):** HCS-style clubs have `scheduled_at` whose UTC
date is one day later than the club-local date. Phase tests must include a fixture
where UTC-now and club-now disagree on what "today" is.

### D2 — Toolbar: at most four top-level things

| Slot | Guest (no identity) | Member (identity/session) | Officer |
|---|---|---|---|
| Primary (phase-driven) | — | today: **Present** | upcoming: none · today: **Present** · completed: **Minutes** (anchor to the minutes section) |
| Share chip | ✓ | ✓ | ✓ ("Copy share link", one label — shipped in #542) |
| **Print & export ▾** menu | ✓ | ✓ | ✓ |
| Edit group | — | — | + Add role · Complete meeting / Reopen meeting (existing controls, unchanged) |

Menu contents (in order): Print agenda · Present (only when not the primary) ·
This meeting's role sheets… (opens a dialog listing the per-meeting PDF links) ·
All role sheets · Word poster (gated on `hasWordOfTheDay`, as today) ·
Download .pptx (gated on `deck && clubName`, as today). Everything stays reachable
in every phase; the menu is one tap deeper, never gone. Print agenda deliberately
lives in the menu even for officers (grill Q2: phase "today" promotes Present, not
Print; a permanent Print slot was considered and declined).

### D3 — One personal strip owns everything about *you*

Three states, one row (extends the existing `ViewingAs` component/placement):

1. **No identity (anon):** `Viewing as guest · I'm a member →` — exactly today's
   rendering. **No availability control** (an availability statement from nobody is
   meaningless; the claim flow already bootstraps identity).
2. **Identity picked (anon) or signed in:** availability chip joins the row —
   `Can't make this one` / tap → `You can't make this one — undo?` (existing
   toggle + inline undo semantics, existing `viewer.canToggleAvailability`
   gating). Signed-in members keep no redundant name display (their identity is
   the session), so for them the strip is the chip alone.
3. **Meeting over:** chip is replaced by the existing attended/did-not-attend
   statement (current behavior, relocated into the strip).

The standalone full-width availability button below the header is removed.

### D4 — Officer role cards: one visible action + ⋯ overflow

| Card state | Visible | ⋯ menu |
|---|---|---|
| open | **Assign…** | Nudge someone · Claim it myself · Remove role |
| claimed | **Confirm** (weight per D5) | Reassign… · Remind (email/WhatsApp) · Edit speech (speakers) · Move up / Move down (speakers) · Release |
| confirmed | — (badge "Confirmed ✓") | Unconfirm · Reassign… · Remind · Edit speech · Move up / Move down · Release |

Member/guest cards are untouched (Claim / Release / take over / Edit speech-own
exactly as today). Drag-and-drop reorder is explicitly out of scope; ↑/↓ become
menu items. Nudge machinery (NudgeButtons / NudgeRecruitPicker prefilled messages)
is reused verbatim behind menu items.

### D5 — Confirm: phase-weighted per-card + one bulk action

- Claimed-card **Confirm** renders `variant="outline"` (quiet) until the
  confirmation window, `variant="default"` (filled) inside it.
- Confirmation window: `CONFIRM_WINDOW_HOURS = 72` — an exported constant in
  `src/lib/` (assertable absolutely, per the cap-constant trap in CLAUDE.md),
  compared against the meeting's scheduled instant.
- The summary strip gains **Confirm all claimed** (officer-only, visible when
  ≥1 claimed slot), issuing the existing per-slot confirm mutation sequentially.
- Unconfirm lives in the ⋯ menu only.

### D6 — Minutes / attendance / awards: phase-gated inline (no tabs)

- **upcoming:** collapsed disclosure headers that carry their counts
  ("Minutes · 3 present · 1 excused · 1 unmarked") — expandable (pre-marking an
  excused absence ahead of time is a supported flow).
- **today / completed:** expanded inline exactly as now (the meeting-night
  single-scroll run sheet is deliberately untouched). On `completed`, the toolbar
  primary (D2) anchors to this section (`id="minutes"`).
- **Outreach card inverts:** visible on upcoming (it's a pre-meeting chase tool),
  collapsed on completed.

### D7 — Delivery: one spec, three independently-shippable PRs

| PR | Scope | Plan |
|---|---|---|
| PR 1 | `meetingPhase` + toolbar (`MeetingToolbar`, `MeetingExportMenu`) + personal strip | `docs/superpowers/plans/2026-08-08-meeting-chrome-pr1-phase-toolbar-strip.md` |
| PR 2 | Officer card overflow (⋯ menu, one visible action) + D5 Confirm weighting + bulk confirm | authored after PR 1 lands |
| PR 3 | D6 minutes/outreach phase gating | authored after PR 2 lands |

PR 2/3 plans are deliberately NOT written yet: this page's fixtures have a
documented merge-cross-product trap (CLAUDE.md, #522 lore) — each successor plan
is authored against the landed predecessor, and each PR re-derives the hostile
fixture list (club name length, emoji, role count × phase × persona) before /ship.

## Test strategy (spec-level obligations)

- `meetingPhase`: full matrix in `meeting-lifecycle.test.ts` — locked, passed-unlocked,
  today, future, injectable `now`, and the UTC-vs-club-day disagreement fixture.
- Toolbar/strip/menu: extracted as pure components (`MeetingToolbar`,
  `MeetingExportMenu`, `MeetingPersonalStrip`) precisely so the 3-phase × 3-persona
  matrix is jsdom-testable — route components cannot mount in jsdom (established
  #542 pattern: `ClubHomeHeader`).
- Label assertions pin **target identity (href/handler), not just strings** (the
  rename trap).
- Route-level wiring stays typecheck-pinned + eyeball QA (same compensating-gate
  pattern the #542 coverage audit recorded).
- `CONFIRM_WINDOW_HOURS` gets an absolute assertion on the constant itself (PR 2).
- Existing guards must stay green untouched: `meeting-share-label.guard.test.ts`,
  `print-page-reset.guard.test.ts`, `print-page-count.test.tsx` (no print surface
  changes in any PR of this spec).

## Out of scope

- Officer sidebar/IA consolidation — that is #540.
- Agenda | Minutes tabs (declined, grill Q6), drag-and-drop reorder (declined, Q4).
- Reminder sending (#7) — D4's "Remind" items reuse the existing nudge
  (mailto/WhatsApp) machinery only.
- Present mode, print layouts, PDF/pptx generation internals — launch points move
  into the menu; the surfaces themselves are untouched.
