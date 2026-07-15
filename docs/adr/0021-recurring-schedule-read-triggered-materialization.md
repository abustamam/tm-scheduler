# ADR-0021: Auto-extend the meeting schedule via read-triggered materialization

Status: Accepted

## Context

#184 shipped a **stateless one-off** batch generator: an admin fills a recurrence form
(`RecurrenceInput` — interval/monthly + weekday + ordinals/interval-weeks + time + a count/until
bound) and `generateOccurrences` (pure, `src/lib/meeting-recurrence.ts`) emits local-calendar
occurrences that `applyBatchCreateMeetings` inserts. Nothing is persisted on the club.

#190 asks for hands-off scheduling: persist a **standing** recurrence rule and keep the calendar
topped up to *N* future meetings automatically. The original triage note assumed this needed a
**background poller** ("top up to N ahead" on a timer), which is why it was parked behind the
reminder-poller infrastructure (#7 → the extracted-then-folded #247). Grilling reopened the
mechanism question and surfaced three models:

1. **Eager + background poller** — a timer materializes future meetings. Needs the single-host
   job-runner infrastructure #7 builds.
2. **Ghost / virtual occurrences** — never materialize; compute upcoming occurrences on the fly
   and only INSERT a meeting when someone acts on it.
3. **Eager + read-triggered top-up** — meetings are real rows, but the top-up runs *synchronously
   and idempotently* on the authenticated reads that already load a club's schedule.

The deciding facts, from the codebase:

- **`a meeting = a real row` is assumed in ~30 read surfaces** (dashboard, `/next`, season grid,
  `/schedule`, club index, member profiles, reporting, …). Ghosts (model 2) would force every
  *upcoming-meeting* surface to merge materialized rows with computed occurrences, plus a
  concurrency-safe materialize-on-access path and a holiday/exceptions mechanism.
- **The empty upcoming meetings *are* the product**: the season grid and the public sign-up sheet
  (#198) exist so members claim role slots on future meetings — which requires those meetings (and
  their `role_slots`) to be real. And the reminder that nudges members to fill an upcoming meeting
  (#7) can't fire for a meeting that doesn't exist.
- A club's schedule only needs topping up when a meeting *passes* — a scale of days, not seconds —
  so nothing here needs a timer's freshness.

## Decision

**Model 3 — eager rows, read-triggered top-up, no background poller.**

1. **Persist the rule** in a dedicated 1:1 `club_meeting_recurrence` table (row present ⇒ has a
   rule), reusing `RecurrenceInput`'s pattern fields minus the one-off bound, plus `keep_ahead`,
   `enabled`, and a nullable `anchor_date` that fixes interval-mode phase. A DB `check` enforces
   the mode↔fields XOR. It **supplements** the free-text `clubs.meetingSchedule` (display-only);
   convergence onto the structured rule as the single source of truth is future work.

2. **Top up on reads.** `ensureScheduleToppedUp(clubId, now)` counts future `scheduled` meetings;
   if below `keep_ahead`, it generates the next occurrences from the rule and inserts the missing
   ones. It runs from the highest common **authenticated** club loader (`getAuthContext`, for a
   real member of the active club — never anonymous, never during read-only impersonation) and
   synchronously after a rule is created/edited. The count query is its own cheap guard, so it is
   a no-op once the schedule is full.

3. **Idempotent + concurrency-safe.** Generated occurrences are deterministic. A unique
   `(club_id, scheduled_at)` index plus `ON CONFLICT DO NOTHING` (shared `insertMeetingWithSlots`,
   also used by batch) makes two concurrent top-ups resolve to exactly `keep_ahead`, never
   double-created. App-level local-date dedup skips any date already occupied by a meeting of
   **any** status.

4. **Cancellation is the skip mechanism.** A cancelled meeting does not count toward `keep_ahead`
   but keeps its date reserved, so the next top-up extends the tail by one without resurrecting it
   — which doubles as one-off holiday skipping. No separate exceptions table.

5. **Edit reconciliation on emptiness, not provenance.** No `source` column. Editing the pattern
   deletes only future meetings that sit on the **old** rule's dates *and* are pristine-empty
   (scheduled, all content blank, no claimed slot, no availability mark), then regenerates under
   the new rule. Customized meetings (touched) and manual/off-old-pattern meetings survive.

6. **No dependency on #247.** Because there is no background job, #190 depends only on #184
   (shipped). The single-host job runner remains #7's concern.

## Consequences

- **Kept simple where it counts:** all ~30 meeting-reading surfaces, the sign-up model, and the
  reminder path keep working unchanged because meetings stay real rows.
- **A dormant club (no member visits) stops extending** until the next authenticated member load —
  acceptable: if nobody is looking, nobody needs the rows yet, and it self-heals on the next visit.
- **Meeting creation can originate from a GET** (the loader). This is deliberate and safe: the
  operation is idempotent and hard-capped at `keep_ahead`, and it is gated to authenticated members
  (never anonymous). Best-effort — a top-up failure is logged and never blocks navigation.
- **Reconciliation can, in principle, delete a manually-created empty meeting** — but only if it
  lands on the *old rule's* dates and is pristine; off-pattern manual meetings are protected by the
  date filter, and touched meetings by the emptiness check.
