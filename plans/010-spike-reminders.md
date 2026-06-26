# Plan 010: Design spike — reminders / notifications

> **Executor instructions**: This is a **design/spike plan**. The deliverable is
> a written design doc that defines the feature and its dependencies — NOT a
> working notification system. Do not build the sender or a scheduler. If
> anything in "STOP conditions" occurs, stop and report. When done, update the
> status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/db/schema.ts src/lib/auth.ts`

## Status

- **Priority**: P3
- **Effort**: M (spike)
- **Risk**: LOW
- **Depends on**: none — but the BUILD that follows is **gated on wiring a real
  email provider** (ADR-0004 pre-launch task), which does not exist yet.
- **Category**: direction
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/7 (pre-existing build issue; this plan is the design spike that precedes it — no duplicate filed)

## Why this matters

`CONTEXT.md:6` names the spreadsheet's real failings: "no reminders, no
at-a-glance 'what's still open,' and edit conflicts." The app already solved the
last two; **reminders are the remaining headline value proposition** and the
README literally advertises "(soon) automatic reminders" (`README.md:6`). The
schema is ready for it: a `notifications` table already exists, deliberately
unused (`src/db/schema.ts:179-191`, `CONTEXT.md:38` "the `notifications` table
exists, unused"). This is the most product-grounded direction in the repo.

But it has a hard prerequisite: **there is no email/SMS delivery wired** — the
magic-link sender is still a `console.log` stub (`src/lib/auth.ts:11-15`,
ADR-0004), tracked as a pre-launch task. A reminder system can't ship before a
real delivery channel exists. This spike defines the feature *and* makes that
sequencing explicit so the team builds things in the right order.

## Current state / grounding

- `notifications` table (`src/db/schema.ts:179-191`): `id`, `userId`, `slotId`,
  `type text`, `channel text`, `sendAt timestamptz`, `sentAt timestamptz`. It's a
  queue: rows with `sendAt <= now()` and `sentAt IS NULL` are due to send. Note
  `type` and `channel` are free-text `text` (not enums) today.
- No code reads or writes `notifications` anywhere
  (`grep -rn "notifications" src` → schema + relations only).
- Delivery: only the magic-link stub exists; no Resend/SES/Twilio integration,
  no API keys, no `.env` entry for a provider.
- Deployment is a single Node host on Hetzner (ADR-0003) — a background
  scheduler can be an in-process interval/cron on that host (no serverless cron
  available), which is a design decision the doc must address.
- Out-of-scope-for-MVP per `CONTEXT.md:38-39` — so this is a deliberate later
  phase being scoped, not MVP creep.

## Deliverable

A design doc at `docs/design/reminders.md` answering everything in "Scope of the
design." No production code, no schema migration, no provider integration.

## Scope of the design (what the doc must answer)

- **Trigger model**: what reminders fire and when. Grounded options to specify
  (pick recommendations): (a) "you have an open/claimed role for a meeting in N
  days," (b) "roles are still open for your club's upcoming meeting" (nudge to
  fill), (c) "you're confirmed for X tomorrow." Map each to rows in
  `notifications` (`type`, `sendAt`, `slotId`/`userId`).
- **Who gets what**: per-member (their claimed slots) vs per-VPE (open-slot
  digests). Tie to the `clubMemberships` roles.
- **Scheduler**: how due rows get picked up and sent on a single Node host —
  an in-process interval that polls `notifications WHERE sendAt <= now() AND
  sentAt IS NULL`, marks `sentAt`, and is idempotent on restart. Address
  concurrency (only-once send) and what happens if the host restarts.
- **Delivery channel**: recommend the provider (the README/ADR mention
  Resend/SES). Define the abstraction — a `sendEmail({to, subject, body})`
  interface that both the magic-link sender and reminders share, so wiring the
  provider once unblocks both. **This is the key cross-feature insight: the email
  provider is a shared dependency, not reminder-specific.**
- **Generation**: when are `notifications` rows created? (e.g. on meeting
  creation, schedule the "N days before" reminders for each slot; on claim,
  schedule the confirmed-for-tomorrow reminder). Specify the write points.
- **Schema gaps**: should `type`/`channel` become enums? Is an index on
  `(sentAt, sendAt)` needed for the poller? Flag as follow-ups; do not migrate.
- **Sequencing**: an explicit ordered dependency list — (1) email provider
  abstraction + magic-link migration to it, (2) notification row generation,
  (3) the poller/scheduler, (4) templates. State that (1) is the ADR-0004
  pre-launch blocker and nothing reminder-facing ships before it.

## Commands you will need

| Purpose      | Command               | Expected |
|--------------|-----------------------|----------|
| Inspect schema | `bun run db:studio` | opens Studio (to view `notifications`) |
| Typecheck    | `bunx tsc --noEmit`    | exit 0 (only if you add throwaway `.ts`) |

## Scope

**In scope** (create):
- `docs/design/reminders.md`

**Out of scope** (do NOT build):
- The email/SMS provider integration (separate pre-launch task; this doc only
  *specifies* the shared abstraction).
- The scheduler/poller code, notification-row generation, or any write to
  `notifications`.
- Schema migrations (enum conversion, indexes) — recommend them in the doc only.
- `src/lib/auth.ts` changes — the magic-link→shared-sender migration is named as
  a dependency, not done here.

## Git workflow

- Branch: `advisor/010-spike-reminders`
- Conventional commit, e.g. `docs: design spike for reminders/notifications`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Map the existing table to the trigger model

Document how each reminder type maps onto `notifications` columns. Identify any
column the current schema can't express and flag it (don't change it).

### Step 2: Design the scheduler and the shared sender abstraction

Specify the in-process poller for the single Node host (idempotency, once-only
send, restart behavior) and the `sendEmail`-style interface shared with
magic-link. Make the shared-dependency sequencing explicit.

### Step 3: Write `docs/design/reminders.md`

Fill in every item under "Scope of the design," ending with the ordered
dependency/sequencing list and the explicit gate on the email provider.

**Verify**: the doc exists and contains the trigger→column mapping, the scheduler
design, the shared-sender abstraction, schema-gap follow-ups, and the sequencing
list with the email-provider gate called out first.

## Done criteria

ALL must hold:

- [ ] `docs/design/reminders.md` exists and covers: trigger model, recipients,
      scheduler design (single-host, idempotent), shared email abstraction,
      generation write-points, schema-gap follow-ups, and ordered sequencing
- [ ] The doc explicitly states the email-provider dependency (ADR-0004) blocks
      the build and must come first
- [ ] No schema, `src/lib/auth.ts`, or other source files changed (`git status`)
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report (do not improvise) if:
- You find the `notifications` table genuinely cannot model the needed reminders
  without schema changes — that's a finding to surface (it would amend the
  ADR-0005-era schema decision), not to implement.
- The scope starts pulling you into building the provider integration — stop;
  that's a different task this spike only depends on.

## Maintenance notes

- This doc's sequencing list should drive the order of the future build plans.
  The email-provider abstraction is shared with magic-link delivery — building it
  well serves both features.
- When the provider is chosen, add its API-key env var to `.env.example`
  (plan 007) as a blank placeholder.
- Reviewer should sanity-check the once-only send design against a host restart
  mid-send (the classic at-least-once vs at-most-once question).
