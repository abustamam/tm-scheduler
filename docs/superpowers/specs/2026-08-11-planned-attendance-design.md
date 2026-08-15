# Planned Attendance (outreach stages + roll call) — Spec

**Status:** brainstormed 2026-08-11 with the maintainer; six decisions locked (D1–D6).
**Origin:** maintainer request — WhatsApp click-to-contact from outreach, an outreach
*stage* rather than a boolean, editable planned attendance for anyone from the meeting
page, and the observation that present/excused/absent is meaningless before a meeting.

## Problem

Three facts about "is this person coming to this meeting" live in three unrelated
places, and none of them can express the one thing a VPE actually needs.

- **`meeting_outreach`** (#340) — row presence = "I asked them about a role". A pure
  boolean, officer-only, surfaced as a checkbox list in `OutreachPanel`. It cannot say
  what the answer *was*.
- **`member_availability`** — row presence = "not available". Written by the member
  about themselves, and by an officer through the season grid. There is **no positive
  signal anywhere in the schema**: silence and "yes, I'll be there" are indistinguishable.
- **`meeting_attendance`** (ADR-0014 / #152) — `present | absent | excused`, edited in
  the Minutes card. `getMinutes` gates on `canEdit || completed`, so an admin sees this
  control from the moment the meeting is created, weeks before anyone can be present.

Consequences today:

1. Contacting someone requires leaving the outreach list: WhatsApp/Email drafts
   (`NudgeButtons`) exist only on role slot cards and in the "Nudge someone" picker,
   both of which are role-scoped. The Outreach panel — the list of people you actually
   need to chase — has no contact affordance at all.
2. An officer cannot record "she replied, she's coming", only "I asked her".
3. An officer cannot set anyone else's planned attendance from the meeting page.
   `setAvailability` accepts an `actorMemberId`, but the meeting page never offers it;
   only the season grid does.
4. Roll call sits below the fold. On mobile the Minutes card is a long scroll past the
   full agenda, on the one night the information is time-critical.
5. The plan/record conflation has already shipped a bug: the meeting page tells anyone
   who never marked themselves unavailable *"You attended this meeting"*, whether or not
   they turned up — [#548](https://github.com/abustamam/tm-scheduler/issues/548).

## Decisions (locked)

### D1 — One status ladder, one table

A single per-`(member, meeting)` status replaces both booleans:

| Stored | Means | Was |
|---|---|---|
| *row absent* | **No answer** | (absence of both rows) |
| `reached_out` | asked, no reply yet | `meeting_outreach` row |
| `coming` | confirmed in | *nothing — new signal* |
| `not_coming` | confirmed out | `member_availability` row |

New table **`meeting_attendance_plan`** — named to pair with `meeting_attendance`
(plan vs. record):

```
id            uuid pk default random
member_id     uuid not null → members.id      on delete cascade
meeting_id    uuid not null → meetings.id     on delete cascade
status        attendance_plan_status not null      -- reached_out | coming | not_coming
created_at    timestamp not null default now()
updated_at    timestamp not null default now()
unique (member_id, meeting_id)                     -- plain unique: ON CONFLICT arbiter
index (meeting_id)
```

`member_availability` and `meeting_outreach` are **dropped**. Rejected alternative:
keep both tables and add a `stage` column to `meeting_outreach`, with one server fn
writing both. Smaller diff, but `member_availability` has four writers besides the
availability server fns — `clearAvailabilityOnSelfClaim` (slots-logic),
`releaseSlotsAndMarkUnavailable` (availability-logic), the membership-collapse merge,
and the season grid — and each would have to remember to keep the outreach row honest.
The consolidation pays a seven-module sweep once instead.

**Migration.** One drizzle migration, generated from the schema, plus a data backfill
in the same file:

1. create `attendance_plan_status` enum + `meeting_attendance_plan`
2. `INSERT … SELECT member_id, meeting_id, 'not_coming', created_at FROM member_availability`
3. ```sql
   INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
   SELECT o.member_id, o.meeting_id, 'reached_out', o.created_at
   FROM meeting_outreach o
   WHERE NOT EXISTS (
     SELECT 1 FROM member_availability a
     WHERE a.member_id = o.member_id AND a.meeting_id = o.meeting_id
   );
   ```
4. `DROP TABLE meeting_outreach; DROP TABLE member_availability;`

Step 3 deliberately discards "we asked them" for a member who is *also* unavailable.
That combination is already invisible: `deriveOutreach` filters unavailable members out
of both its lists, so no rendered state is lost. No `CREATE INDEX CONCURRENTLY` — it
cannot run inside drizzle's migration transaction and the deploy fails closed.

### D2 — One panel, two modes, switching on the existing phase

`MeetingAttendancePanel` renders in two modes driven by the **existing**
`meetingPhase()` helper (`src/lib/meeting-lifecycle.ts`, `upcoming | today | completed`,
injectable `now`, already computed by the route at line ~355). No new date logic:

```
mode = phase === "upcoming" ? "plan" : "roll"
```

| | **plan** (`upcoming`) | **roll** (`today`, `completed`) |
|---|---|---|
| Title | Planned attendance | Attendance |
| Counts | `7 coming · 2 out · 4 no answer` | `12 present · 1 excused · 3 unmarked` |
| Sort | no answer → reached out → coming → not coming; alphabetical within each | alphabetical |
| Rows | whole active roster; assigned members included, with a role chip | same, plus a **Guests** group with "+ Add guest" |
| Contact | WhatsApp + Email per row | kept while `today`, hidden once `completed` |
| Writes | `meeting_attendance_plan` | `meeting_attendance` |

Contact survives into `today` deliberately: "the Timer hasn't arrived and we start in ten
minutes" is the most urgent message a VPE ever sends, and it is exactly the moment the
panel is on screen. Only `completed` — where every row is a historical record — drops it.

Roll-mode counts report **real rows only**; a dashed suggestion is not counted as present.
`3 unmarked` therefore means three rows nobody has confirmed, whatever their plan said.

Note the panel flips a day **earlier** than the agenda locks — `phase === "today"` while
`isMeetingOver` is still false — because the agenda deliberately stays editable through
meeting day. That asymmetry is intentional: on meeting morning the officer wants roll
call, while members are still filling open roles.

### D3 — Plan seeds the record as a *suggestion*, never as a fact

In roll mode a member with no `meeting_attendance` row renders a **dashed suggestion**
derived from their plan — `coming → Present?`, `not_coming → Excused?`, anything else →
`Unmarked`. Tapping it writes the real row and it renders solid.

This needs **no schema change**: `getMinutes` already reports `status: null` for a
member with no attendance row, so "suggested" is exactly "no row yet" and a plan
physically cannot be mistaken for a record. This is the direct guard against #548.

### D4 — Placement: sticky right rail on desktop, stacked card on mobile

The meeting route already renders at `max-w-workspace` (1180px) for officers and
`max-w-reading` (48rem) for the anonymous read (`containerClass`, route line ~454). The
panel is officer-visible only, so it only ever appears in the wide variant.

- **≥ `lg`:** two-column body — agenda left, panel in a sticky right rail (~340px).
  Header, announcements and toolbar stay full width above.
- **< `lg`:** the panel is a card directly beneath the toolbar, above the roles list.
  In **plan** mode it renders **collapsed to its counts line** (tap to expand), so a
  15-person roster does not push the agenda off screen. In **roll** mode it renders
  expanded — the list is the task.

### D5 — Row anatomy and contact

One line per member: name (truncating), status chip with a 4-item dropdown, and a
WhatsApp icon button. Email appears in the same position when the member has no phone;
neither on file → the existing muted "No contact on file".

- Drafts reuse `buildNudge` with a new `mode: "attendance"` and no `roleName`, so the
  desktop-vs-mobile WhatsApp entry point (#485), the preferred-name greeting (#486) and
  the email fallback all come for free. Copy: *"Hi Sam, are you able to make our Tue 19
  Aug meeting? Agenda here: …"*
- Role-specific asks stay exactly where they are — on the slot cards and in "Nudge
  someone". This panel answers *who is even coming*; those answer *who takes this role*.
- Tapping WhatsApp or Email advances **No answer → Reached out**, logged `via: "nudge"`,
  matching the current auto-mark. A row already at `coming` or `not_coming` is untouched.
- Links stay `<Button asChild><a>`. A bare `<a>` is repainted by the unlayered
  `a:not([data-slot="button"])` rule in `styles.css` and lands back on the 3.81:1
  contrast bug from #559.

### D6 — Who can write

| Actor | May set |
|---|---|
| Officer (`requireClubRole(["admin"])`) | any member's row |
| Member (session or anon roster identity) | **only their own** row |

The member path stays session-less and resolves its actor through `requestWriteActor`,
preserving the anonymous roster-pick identity that dominates this product. It **adds the
archived-club gate** the session-less writers currently lack (#555) rather than adding
another ungated one.

The personal strip gains **"I'll be there"** beside today's "I can't make this one";
both write this ladder. `clearAvailabilityOnSelfClaim` — claiming a role clears your
unavailable flag — becomes "claiming a role sets you to `coming`", which is more
truthful than deleting the row.

## Surfaces absorbed

| Removed | Replaced by |
|---|---|
| `OutreachPanel` (`src/components/club/outreach-panel.tsx`) | this panel, widened to the whole roster |
| "Not available this week" section (`meeting-agenda.tsx` ~L421) | `not_coming` rows in this panel |
| `AttendanceSection` + "Guests present" (`meeting-minutes.tsx`) | roll mode; the Minutes card links up to the panel |

`getMinutes` keeps returning its counts, so the minutes PDF and the minutes email are
unchanged. The Table Topics speaker picker keeps its `status === "present" || null`
rule (#170/#218) unchanged.

## Server surface

New module pair, following the `server-modules.guard.test.ts` rule (a `createServerFn`
module exports only server fns and types; db logic lives in a sibling `*-logic.ts` that
client code never imports):

- `src/server/attendance-plan.ts` — `setPlannedAttendance`, `clearPlannedAttendance`
- `src/server/attendance-plan-logic.ts` — the db work, directly testable

`setAttendance` / `addMinutesGuest` / `removeMinutesGuest` are reused as-is for roll
mode; no change to `minutes.ts`.

**The two modes need two write paths, and that is correct.** `gateAdmin` in `minutes.ts`
deliberately does *not* call `assertMeetingNotLocked` — minutes are written after a
meeting is completed and locked. `setContacted` and `setAvailability` both *do* assert
it. So plan writes stay rejected on a locked meeting and roll writes stay allowed; one
server fn could not honour both.

## Offline

`MeetingMinutes` carries the #176 offline write queue — a persisted snapshot plus an
ordered op log drained on reconnect, stop-on-failure — and its `MinutesOp` union already
has `setAttendance` and `addGuest` variants. Moving roll call out of that component
without moving the queue would silently delete a shipped capability, and would fail
exactly where it matters: a meeting room with no signal.

The queue therefore lifts out of `MeetingMinutes` into a shared hook
(`useMinutesOfflineQueue`) that both the panel and the Minutes card consume, so panel
edits and minutes edits share **one** queue and drain in order. Plan-mode writes are
online-only (they are not time-critical) and surface the existing offline banner.

## Error handling

- Optimistic per-row update with rollback and a toast on failure — the existing
  `pendingId` pattern from `OutreachPanel`, which also guards a rapid double-toggle.
- Locked meeting: plan writes reject with `MEETING_LOCKED_MESSAGE`; the chips render
  disabled rather than missing.
- Preview-as-member hides the panel entirely, like every other officer surface.
- Guests appear only in roll mode. Pre-meeting guest expectation is out of scope — the
  guest pipeline (ADR-0018) has its own stages.

## Testing

Coverage target 85% against the diff. Integration suites need
`TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` exported or ~630 tests
skip while the run still reads green, and `tm_test` needs
`DATABASE_URL=…tm_test bun run db:push --force` after the schema change.

1. **The seven-module sweep is the highest-risk part, and today's fixtures structurally
   cannot fail on it.** Every reader that means "row exists ⇒ unavailable" gains
   `and status = 'not_coming'`: `availability.ts`, `availability-logic.ts`,
   `slots-logic.ts`, `season-grid-logic.ts`, `recurrence-rule-logic.ts`,
   `membership-collapse-logic.ts`, `meetings.ts`. Miss one and a member who confirmed
   **coming** is treated as unavailable — released from roles, greyed on the grid,
   counted as a "touched" meeting by the recurrence materializer. No existing fixture
   contains a row that isn't `not_coming`, so each of those seven suites gets a `coming`
   **and** a `reached_out` member added to its fixture. (CLAUDE.md, "a fixture that spans
   ONE axis is not a guarantee".)
2. **Plan must never become a record — assert the database, not the chip.** After the
   phase flips with a plan of `coming`, `meeting_attendance` has **no row** and
   `getMinutes` reports the member unmarked; tapping the suggestion is what creates it.
   A jsdom assertion on the dashed border passes with the write wired wrong, which is
   the shape of #548.
3. **Migration/backfill**, against real rows: availability → `not_coming`;
   outreach-only → `reached_out`; both → `not_coming` wins and the outreach fact is
   dropped; neither → no row.
4. **Mode boundary** is a club-local date: inject `now` into `meetingPhase` and assert
   day-before / day-of / day-after in a non-UTC timezone.
5. **Route wiring** is invisible to component tests — the meeting route cannot mount in
   jsdom (#541). A comment-blind source guard via `#/test/guard-source` pins the prop
   that feeds the mode and the panel's placement in the rail, same shape as
   `meeting-chrome-wiring.guard.test.ts`.
6. **Offline:** a roll-mode edit and a Minutes edit made offline land in **one** queue
   and drain in order. Assert the interleaving — a per-surface queue passes a naive
   "it saved" test and loses ops in practice.
7. **Deletions:** assert the three absorbed surfaces are gone, and that `getMinutes`
   counts still feed the minutes PDF and email unchanged.
8. **Authz:** a member setting another member's row is rejected; an officer setting any
   row succeeds; an archived club rejects the public member path (#555).

## Delivery

Three PRs. Each is shippable on its own; each earns its own plan, authored after its
predecessor lands.

**PR 1 — the data model, with no visual change.** New enum + table, the migration and
backfill, `attendance-plan.ts` / `attendance-plan-logic.ts`, and the seven-module sweep.
The existing `OutreachPanel` checkbox and the existing availability controls are rewired
onto the new store and keep behaving identically — the checkbox writes `reached_out` and
clears to no row, the availability button writes `not_coming`. Nothing on screen moves.
This isolates the riskiest part of the change (test #1 below) from any UI review.

**PR 2 — the panel, plan mode.** `MeetingAttendancePanel` in plan mode, the rail/stacked
layout (D4), the row anatomy and contact drafts (D5), the personal strip's "I'll be
there". Absorbs and deletes `OutreachPanel` and the "Not available this week" section.
Minutes is untouched, so roll call stays where it is.

**PR 3 — roll mode.** The suggestion rendering (D3), the guests group, absorbing and
deleting the Minutes `AttendanceSection`, and lifting the #176 offline queue into the
shared hook. The offline refactor is the reason this is its own PR rather than a tail on
PR 2 — it touches a shipped capability that no other part of this work depends on.

## Out of scope

- Pre-meeting guest expectation ("three visitors are coming").
- A "coming but passed on the role" rung (Q1 option C). Add later if re-asking the same
  person becomes a real cost; the ladder has room.
- Reminder *sending* (#7). This panel drafts; the human sends, as everywhere else.
- Backfilling `meeting_attendance` from historical plans.
