# Design: Reminders / Notifications

**Related issue**: [#7 — Reminder send job over the notifications table](https://github.com/abustamam/tm-scheduler/issues/7)
**Status**: Design spike only — no code ships from this doc.
**Gate**: The entire build is blocked on wiring a real email provider (ADR-0004 pre-launch task). The `sendMagicLink` callback in `src/lib/auth.ts:21-24` is still a `console.log` stub. Nothing reminder-facing ships before that is resolved.

---

## Background

`CONTEXT.md:6` names the spreadsheet's headline failings: "no reminders, no at-a-glance 'what's still open,' and edit conflicts." The app has addressed the latter two; reminders are the remaining headline value proposition (the README advertises "(soon) automatic reminders"). The schema is already ready: a `notifications` table exists in `src/db/schema.ts:180-192`, deliberately unused per `CONTEXT.md:38`.

This document specifies the trigger model, recipients, scheduler design, shared email abstraction, write points, schema gaps, and sequencing. No code is written as part of this spike.

---

## 1. Existing `notifications` table

```
notifications (
  id         uuid PRIMARY KEY,
  userId     text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slotId     uuid NOT NULL REFERENCES role_slots(id) ON DELETE CASCADE,
  type       text NOT NULL,        -- free text today; see §6 schema gap
  channel    text NOT NULL,        -- free text today; see §6 schema gap
  sendAt     timestamptz NOT NULL, -- when the notification is due
  sentAt     timestamptz           -- NULL = pending; non-NULL = sent (the queue flag)
)
```

The table is a **send queue**: rows where `sendAt <= now() AND sentAt IS NULL` are due to deliver.

---

## 2. Trigger model

Three reminder types, each mapping to one or more rows in `notifications`:

### 2a. `slot_reminder` — you have a role coming up

Sent to the **member who holds a claimed/confirmed slot**, reminding them of their commitment.

| Column   | Value |
|----------|-------|
| `userId` | `role_slots.assignedUserId` |
| `slotId` | the slot being reminded |
| `type`   | `"slot_reminder"` |
| `channel`| `"email"` |
| `sendAt` | `meeting.scheduledAt - 24h` (first reminder) |
| `sentAt` | NULL until sent |

A second row can be added with `sendAt = meeting.scheduledAt - 1h` for a day-of nudge. Both rows share the same `slotId` and `userId`; the poller sends them independently.

### 2b. `slot_claimed_confirmation` — you just claimed a slot

Sent to the **member immediately after they claim a slot**, confirming what they signed up for.

| Column   | Value |
|----------|-------|
| `userId` | the claiming member |
| `slotId` | the slot just claimed |
| `type`   | `"slot_claimed_confirmation"` |
| `channel`| `"email"` |
| `sendAt` | `now()` (or `now() + 30s` to survive a quick release) |
| `sentAt` | NULL until sent |

### 2c. `open_slots_digest` — roles are still unfilled (VPE nudge)

Sent to the **VPE/admin** when a meeting still has open slots, prompting them to recruit.

| Column   | Value |
|----------|-------|
| `userId` | VPE's userId (from `club_memberships` where `clubRole = 'vpe'`) |
| `slotId` | the open slot |
| `type`   | `"open_slots_digest"` |
| `channel`| `"email"` |
| `sendAt` | `meeting.scheduledAt - 72h` (3 days before) |
| `sentAt` | NULL until sent |

**Schema limitation**: One row is inserted per open slot. The current `slotId NOT NULL` constraint prevents a single meeting-level digest notification. As a result, the VPE receives one email per open slot rather than a single batched digest. This is noted as a schema gap in §6.

---

## 3. Recipients

| Trigger | Recipient | How to resolve |
|---------|-----------|----------------|
| `slot_reminder` | Slot assignee | `role_slots.assignedUserId` → `user.email` |
| `slot_claimed_confirmation` | Claiming member | Same |
| `open_slots_digest` | Club VPE/admin | Query `club_memberships WHERE clubRole IN ('vpe', 'admin') AND status = 'active'` for the meeting's `clubId`; insert one row per VPE × per open slot |

Email address resolution: join `notifications.userId` → `user.email` (Better-Auth's `user` table, from `src/db/auth-schema.ts`).

---

## 4. Scheduler — in-process poller (single Node host)

Deployment is a single Hetzner VPS running the Nitro/Node process (ADR-0003). No serverless cron is available. The natural design is an **in-process interval that starts with the server**.

### 4a. Poll query

```sql
SELECT * FROM notifications
WHERE send_at <= now() AND sent_at IS NULL
ORDER BY send_at
LIMIT 100;
```

Run every **60 seconds**. A 1-minute delivery jitter is acceptable for reminders scheduled days in advance.

### 4b. Once-only send (atomic claim)

The critical correctness requirement is that each notification is sent exactly once, even across server restarts. The recommended pattern is **mark-then-send (at-most-once)**:

```sql
UPDATE notifications
SET sent_at = now()
WHERE id = $id AND sent_at IS NULL
RETURNING *;
```

If this UPDATE returns a row, the poller owns it and proceeds to send. If it returns nothing, another iteration already claimed it. Because the single Hetzner VPS runs one Node process, concurrent-sender races do not occur in practice — but the atomic guard is worth keeping for correctness and future resilience.

The trade-off:
- **At-most-once (mark first, then send)**: a crash between marking and sending drops the notification silently. For a reminder, this is mildly annoying but acceptable — no duplicate emails.
- **At-least-once (send first, then mark)**: a crash after sending but before marking causes a duplicate email on restart. For Toastmasters reminders, a duplicate "you have a role tomorrow" received multiple times is more disruptive than a missed one. **Recommendation: at-most-once.**

### 4c. Restart behavior

On server start, the poller's first tick runs immediately (or within the first 60-second window). Any rows that were due but unprocessed before the restart will be picked up. Rows already marked `sentAt IS NOT NULL` are skipped. There is no "in-flight" state: the atomic UPDATE is the only state transition.

### 4d. Implementation shape (not built here)

```
src/lib/notification-poller.ts
  startNotificationPoller(): void
    setInterval(poll, 60_000)
    poll():
      atomic UPDATE RETURNING for each due row
      sendEmail(resolvedRecipient, template(row.type, slot, meeting))
```

Wire `startNotificationPoller()` in the Nitro server startup hook (entry-server / app lifecycle). Do NOT build this until the email provider is wired (see §5 and §7).

---

## 5. Shared email abstraction — the key cross-feature dependency

Both magic-link auth and reminders need to send email. Currently `sendMagicLink` in `src/lib/auth.ts` is:

```typescript
sendMagicLink: async ({ email, url }) => {
  console.log(`\n[magic-link] sign-in link for ${email}:\n${url}\n`);
},
```

When a real provider is wired, it should be done via a **shared interface** that both features consume. Wiring the provider once unblocks both magic-link delivery and reminders simultaneously — this is the key cross-feature insight.

### Proposed interface

```typescript
// src/lib/email.ts  (not written yet — specifying the shape here)
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string; // plain-text fallback
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  // implemented with Resend (or SES) when the provider is chosen
}
```

Then:
- `src/lib/auth.ts` magic-link → calls `sendEmail({ to: email, subject: 'Sign in to TM Scheduler', html: ... })`
- The notification poller → calls `sendEmail(resolvedTemplate)` per claimed row

**Recommended provider**: **Resend** — simple REST API, first-class TypeScript SDK, generous free tier, mentioned in ADR-0004. SES is a credible fallback if AWS is already in the VPS environment.

Once chosen, add the provider API key placeholder to `.env.example` (per plan 007 maintenance note in `plans/README.md`).

---

## 6. Notification row generation — write points

Rows are inserted (or deleted) at these domain events:

| Event | Action |
|-------|--------|
| **Meeting created** | For each slot, insert one `open_slots_digest` row per VPE/admin at `sendAt = meeting.scheduledAt - 72h` |
| **Slot claimed** (`claimSlot`) | Insert `slot_claimed_confirmation` at `sendAt = now()`; insert `slot_reminder` at `sendAt = meeting.scheduledAt - 24h` (and optionally -1h); delete the `open_slots_digest` rows for this slot (it is no longer open) |
| **Slot released** (`releaseSlot`) | Delete the `slot_reminder` and `slot_claimed_confirmation` rows for this slot/userId that have `sentAt IS NULL`; re-insert `open_slots_digest` rows for the VPE (slot is open again) |
| **Meeting cancelled** | Delete all `notifications` rows where `sentAt IS NULL` for any slot belonging to the cancelled meeting |

Write points live in the server functions that already own these transitions (`claimSlot`, `releaseSlot`, meeting create/cancel). The notification inserts/deletes should be part of the same DB transaction as the primary state change to keep the two tables consistent.

---

## 7. Schema gaps (flag; do not migrate)

These are follow-up items, not blocking the design, but should be addressed before the build lands:

### 7a. `type` and `channel` are free text

Values like `"slot_reminder"` and `"email"` are free strings today. Converting them to Postgres enums (`notification_type_enum`, `notification_channel_enum`) would:
- Enforce valid values at the DB level
- Make the Drizzle schema self-documenting

**Recommendation**: add `pgEnum("notification_type", ["slot_reminder", "slot_claimed_confirmation", "open_slots_digest"])` and `pgEnum("notification_channel", ["email"])` in `src/db/schema.ts`, generate and apply a migration before inserting the first notification rows.

### 7b. `slotId NOT NULL` prevents meeting-level notifications

The `open_slots_digest` use case is naturally meeting-level (one email, N open slots). The current schema forces one row per open slot (N emails per VPE). A better schema would add:

```
meetingId uuid REFERENCES meetings(id) ON DELETE CASCADE,  -- nullable
-- and make slotId nullable
slotId    uuid REFERENCES role_slots(id) ON DELETE CASCADE -- nullable
```

with a check constraint ensuring at least one of `slotId` / `meetingId` is non-null. This enables a true single-row digest per VPE per meeting.

For MVP, the per-slot workaround is acceptable (the poller sends N emails rather than one digest). Flag for the first schema revision.

### 7c. Missing index for the poller query

The poll query `WHERE send_at <= now() AND sent_at IS NULL` will do a sequential scan without an index. A **partial index** is optimal:

```sql
CREATE INDEX notifications_pending_idx
  ON notifications (send_at)
  WHERE sent_at IS NULL;
```

As notification volume grows (each meeting × each slot × 2 reminders), this index becomes critical. Generate it as a Drizzle migration before the poller ships.

---

## 8. Sequencing — ordered dependency list

**Step 1 is a hard gate. Nothing from steps 2–5 ships before step 1 is complete.**

1. **Email provider abstraction** *(ADR-0004 pre-launch blocker — the gate)*
   Create `src/lib/email.ts` with the `sendEmail` interface; implement with Resend (or SES); migrate `sendMagicLink` in `src/lib/auth.ts` to call `sendEmail(...)` instead of `console.log`. Add the provider API key to `.env.example`. This single step unblocks both magic-link delivery in production and all reminder sending.

2. **Schema migrations**
   - Enum-ize `type` → `notification_type_enum`, `channel` → `notification_channel_enum`.
   - Add partial index `notifications_pending_idx ON (send_at) WHERE sent_at IS NULL`.
   - (Optional, recommended) Make `slotId` nullable, add `meetingId`, add check constraint — enables true meeting-level digest notifications.

3. **Notification row generation**
   Instrument `claimSlot`, `releaseSlot`, meeting-create, and meeting-cancel with the notification inserts/deletes described in §6. Each write should be inside the same transaction as the primary state change.

4. **Poller / scheduler**
   Implement `startNotificationPoller()` in `src/lib/notification-poller.ts` and wire it to the Nitro server startup. Uses the atomic `UPDATE ... WHERE sent_at IS NULL RETURNING *` pattern from §4b and calls `sendEmail(...)` from step 1.

5. **Email templates**
   Author HTML + plain-text templates for each `type` value (`slot_reminder`, `slot_claimed_confirmation`, `open_slots_digest`). Can be inline strings initially; extract to a template system if the set grows.

---

## 9. Drift note (for future executors)

Checked via `git diff --stat 0e33f82..HEAD -- src/db/schema.ts src/lib/auth.ts` before writing this doc. The drift since the plan baseline is:
- `src/db/schema.ts:62` — `timezone` field added to `clubs` (plan 003; inconsequential for notifications).
- `src/lib/auth.ts` — rate-limiting block added (plan 006); `sendMagicLink` stub is unchanged.

The `notifications` table is identical to the baseline; no application code reads or writes it (`grep -rn "notifications" src` hits schema + relations only).
