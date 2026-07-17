# ADR-0023: Send due reminders from an in-process poller booted by a Nitro plugin

Status: Accepted

## Context

The `notifications` table has existed since the MVP as schema-only ("table only; sending logic is
out of scope" — CONTEXT.md). #271 is the delivery **foundation** that turns it on: given DUE rows
(`send_at <= now()` AND `sent_at IS NULL`), send each reliably and **exactly once**, through the
existing email transport (`src/lib/email.ts` — Resend in prod, console in dev). Producers that
enqueue rows are separate children of the reminders epic #7 (#272 role reminders, #274
preferences/unsubscribe); this ADR is only about *how the send job runs and is invoked*.

Three constraints from the codebase shaped the mechanism:

- **ADR-0007 fixes a single persistent Node server on Railway** (Nitro `node-server`, a long-lived
  `node-postgres` pool). It explicitly reserves the "future reminders poller" as an *in-process
  interval* and rules out edge/serverless/cron reworks. So the send loop must live inside the one
  server process — not a separate cron container, not an edge worker.
- **We already have an at-most-once claim pattern** — the ADR-0005 conditional UPDATE
  (`WHERE status = 'open'`) that lets exactly one racing writer flip a slot. Reusing it avoids a
  new locking primitive.
- **The server-module client-bundle rule** (CLAUDE.md "Data layer"): db-touching logic must live
  in a `*-logic.ts` that no client route imports, or `pg` leaks into the browser bundle.

The open question was purely the **invocation seam**: how does a long-running interval get started
exactly once when the Node server boots, and stopped cleanly on shutdown, given TanStack Start owns
the server entry (`.output/server/index.mjs`, which we don't hand-edit)?

## Decision

**An in-process `setInterval` poller, booted once by a Nitro runtime plugin, that claims each due
row with a conditional UPDATE before sending.**

1. **Boot via a Nitro plugin.** `src/server/reminder-poller.nitro.ts` is a `definePlugin` (from
   `nitro`) registered through `nitro({ plugins: [...] })` in `vite.config.ts`. Nitro runs it once
   when the server process starts, which is the in-process equivalent of a boot hook without
   touching the generated entry. It calls `startReminderPoller()` and registers the runtime `close`
   hook to `stopReminderPoller()` so a graceful shutdown / dev-server restart never leaks an
   interval.

2. **One interval, overlap-guarded.** `startReminderPoller()` (`src/server/reminder-poller.ts`)
   starts a single `setInterval` (default 60s, `REMINDER_POLL_INTERVAL_MS` to override,
   `DISABLE_REMINDER_POLLER=1` to opt out; the timer is `unref()`ed so it never holds the process
   open). A re-entrancy flag makes a tick a **no-op while the previous tick is still in flight**, so
   a slow send batch can't stack overlapping ticks in the single process. A thrown tick is logged
   and swallowed — the poller survives a bad tick.

3. **At-most-once via a claim-before-send conditional UPDATE.** `processDueNotifications`
   (`src/server/notifications-logic.ts`) selects due rows, then for each issues
   `UPDATE ... SET attempts = attempts + 1, last_attempted_at = now WHERE id = ? AND sent_at IS NULL
   AND attempts = <read value>`. `attempts` is an optimistic-lock token: under concurrent ticks
   exactly one UPDATE matches (Postgres row-lock re-check, ADR-0005 pattern); the loser affects zero
   rows and skips. Only the winner sends. On success `sent_at` is set; on failure `sent_at` stays
   NULL and `last_error` is recorded, leaving the row for a **bounded retry**.

4. **Bounded retry with backoff.** New columns `attempts`, `last_attempted_at`, `last_error` were
   added to `notifications`. Selection excludes rows at `attempts >= MAX_SEND_ATTEMPTS` (5) and rows
   whose `last_attempted_at` is within `RETRY_BACKOFF_MS` (5 min) — the backoff both paces retries
   and keeps a just-claimed row out of the due set until its tick finishes.

5. **Channel routing.** The row's `channel` decides delivery. Only `email` is wired in this
   foundation (routed to `sendEmail`); any other channel is recorded as an error (not sent) so it
   never silently loops. The email body is rendered from the joined slot context (role, club,
   meeting date), since a row carries no stored copy; producers may enrich it later.

6. **Bundle-safe split.** All db logic lives in `notifications-logic.ts` (integration-tested by
   mocking `#/db` → the test db). The poller and the Nitro plugin are server-only modules, reachable
   only from the boot path, never from a client route — so `pg` stays out of the browser bundle.

## Consequences

- **No new infrastructure.** The send job rides the existing single Node server (ADR-0007); no cron
  container, no edge worker, no external scheduler. Railway deploys unchanged.
- **At-most-once, not exactly-once.** A crash between claiming (`attempts` bumped) and setting
  `sent_at` costs one attempt from the retry budget, not a duplicate send — the deliberate trade
  the #271 acceptance criteria ask for ("sent at most once").
- **Single-instance assumption.** Correctness under concurrency comes from the DB claim, so multiple
  server replicas would still be safe (each claim is atomic), but the poller is designed for the
  one-process Railway model; horizontal scaling would want a leased/queued runner instead.
- **A dormant queue costs one cheap SELECT per minute.** When nothing is due the tick selects zero
  rows and logs nothing; the indexless scan is trivial at this app's volume (add a partial index on
  `(send_at) WHERE sent_at IS NULL` if the table grows).
- **Producers are decoupled.** #272/#274 only need to INSERT rows (an `enqueueNotification` helper
  exists); the poller delivers whatever is due regardless of who wrote it.
