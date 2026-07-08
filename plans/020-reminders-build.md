# Plan 020: Build the reminders send path (notifications schema v2, write points, poller, templates)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6a37548..HEAD -- src/db/schema.ts src/server/slots.ts src/server/meetings.ts src/server/meetings-logic.ts src/lib/email.ts vite.config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (plan 014 touches the same `slots.ts` handlers — if both run, land 014 first and put the reassign write point inside its extracted `reassignSlotCore`)
- **Category**: direction (feature build — issue [#7](https://github.com/abustamam/tm-scheduler/issues/7))
- **Planned at**: commit `6a37548`, 2026-07-08
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/7 (pre-existing; plan comment posted 2026-07-08)

## Why this matters

Reminders are the app's stated reason to exist: `CONTEXT.md:6` names "no
reminders" as the replaced spreadsheet's headline failing, and the README
advertises "(soon) automatic reminders". A full design spike exists
(`docs/design/reminders.md`) and its single hard gate — a real email provider
— has since shipped (`src/lib/email.ts`, Resend). Nothing reminder-facing
exists in code: no reads/writes of the `notifications` table anywhere outside
`src/db/schema.ts`.

**Read `docs/design/reminders.md` before starting.** This plan follows its
trigger model (§2), at-most-once send pattern (§4b), and sequencing (§8), but
**supersedes its schema/recipient details**, which predate the
Person/Membership model — the corrections are inlined below.

## Current state

### Design-doc drift you must apply (authoritative reconciliation)

The design doc references `role_slots.assignedUserId`, `club_memberships`,
and `clubRole = 'vpe'`. All three are gone:

- Slots assign a **Membership**: `role_slots.assigned_member_id` → `members.id`.
- Roles live on `members.club_role`, enum `["admin", "member"]` (`vpe`
  collapsed into `admin`, ADR-0008 Phase B).
- Most members have **no sign-in account** (self-serve model). Emails live on
  the roster: `members.email` (per-club, nullable) with `people.email`
  (person-level, nullable) as fallback. Recipients are therefore **members**,
  not Better-Auth users.

### The current `notifications` table (`src/db/schema.ts:576-588`)

```ts
export const notifications = pgTable("notifications", {
	id: uuid("id").defaultRandom().primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	slotId: uuid("slot_id")
		.notNull()
		.references(() => roleSlots.id, { onDelete: "cascade" }),
	type: text("type").notNull(),
	channel: text("channel").notNull(),
	sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true }),
});
```

No application code reads or writes it (verify:
`grep -rln "notifications" src/ --include="*.ts" | grep -v schema` → empty),
so the schema can be reshaped without data migration concerns — but see STOP
condition 1 (verify the production table is empty before assuming).

### Write-point homes (all existing, all already transactional or easily so)

- `claimSlot` — `src/server/slots.ts:42` (handler `db.transaction` starts
  line 67).
- `releaseSlot` — `src/server/slots.ts:120`.
- `reassignSlot` — `src/server/slots.ts:298` (its `db.transaction` at 344; if
  plan 014 landed, the body is `reassignSlotCore` in `slots-logic.ts`).
- `createMeeting` — `src/server/meetings.ts:336` → logic in
  `src/server/meetings-logic.ts` (slot generation lives there).
- Reschedule/cancel — `applyMeetingUpdate` in `src/server/meetings-logic.ts:83`;
  it already detects a schedule change
  (`toMinute(next.scheduledAt) !== toMinute(meeting.scheduledAt)`, line 113)
  and handles `status` (meeting cancel is a status change to `"cancelled"` —
  locate the exact branch; STOP if cancel is not handled in this function).

### Email transport (exists — do not modify)

`src/lib/email.ts` exports
`sendEmail({ to, subject, html, text }): Promise<void>`; with no
`RESEND_API_KEY` it logs to console (dev), with a key it sends via Resend and
throws on failure. `src/lib/magic-link-email.ts` (+ its `.test.ts`) is the
exemplar for a template module.

### Server startup hook

There is no server entry file; Nitro is wired in `vite.config.ts`:

```ts
		nitro({ rollupConfig: { external: [/^@sentry\//] } }),
```

Nitro supports startup plugins. Two candidate mechanisms (try in order, see
Step 6): (A) pass `plugins: ["./src/server-plugins/notification-poller.ts"]`
in the `nitro({...})` options; (B) a `server/plugins/` directory that Nitro
auto-scans. Verification is empirical (boot log line).

### Conventions that apply

- DB logic in `*-logic.ts` modules (testable, take `DbOrTx`/db as needed);
  server-fn modules export only `createServerFn`s + types
  (`server-modules.guard.test.ts` — it scans `src/server/*.ts` files
  containing `createServerFn`).
- Integration tests: `describe.skipIf(!hasTestDb)` against `testDb` from
  `src/test/db.ts`; mock `#/db` → testDb (see `speeches.integration.test.ts`).
- Vocabulary (CONTEXT.md): Membership/member row, Role slot, Meeting. Use
  `memberId` for the recipient.
- Biome tabs/double quotes; migrations via `bun run db:generate` +
  `db:migrate` (never hand-edit `drizzle/`; CI fails on schema/migration
  drift).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `bun install` | exit 0 |
| Generate migration | `bun run db:generate` | new file in `drizzle/` |
| Apply locally | `bun run db:migrate` | exit 0 (needs `.env.local` DATABASE_URL) |
| Lint/format | `bun run check` | exit 0 |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Tests | `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test` | all pass |
| Build | `bun run build` | exit 0 |
| Boot the built server | `node .output/server/index.mjs` (with `.env.local` vars exported) | poller start log appears |

(`tm_test` and the dev DB live in the running `dev-postgres` container —
never start a new Postgres.)

## Scope

**In scope**:

- `src/db/schema.ts` (notifications table + relations) and the generated
  migration in `drizzle/`
- `src/server/notifications-logic.ts` (new)
- `src/server/notification-poller-logic.ts` (new)
- `src/server-plugins/notification-poller.ts` (new; location may shift per
  Step 6 outcome)
- `src/lib/notification-emails.ts` (+ test) (new)
- Write-point wiring lines in `src/server/slots.ts`,
  `src/server/meetings.ts`/`meetings-logic.ts` (and `slots-logic.ts` if plan
  014 landed)
- `vite.config.ts` (plugin registration only)
- New tests: `src/server/notifications.integration.test.ts`,
  `src/lib/notification-emails.test.ts`

**Out of scope** (do NOT touch):

- `src/lib/email.ts`, `src/lib/auth.ts`, `src/lib/magic-link-email.ts`.
- The agenda "Remind unfilled" button (toast-only stub) — manual nudges are a
  separate feature; this plan is scheduled sends only.
- Any UI. No routes, no components.
- In-app notification channel, digest batching across meetings, quiet hours —
  future work.
- The claim/release/reassign guard semantics (plan 014's territory).

## Git workflow

- Branch: `advisor/020-reminders-build` (dedicated git worktree — repo rule;
  fresh worktree needs `bun install` + `.env.local` copied before db/build
  commands).
- Commit per step; conventional style, e.g.
  `feat(reminders): notifications schema v2 (member-keyed, meeting-level digest)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reshape the notifications table

In `src/db/schema.ts` replace the notifications table with:

```ts
export const notificationTypeEnum = pgEnum("notification_type", [
	"slot_reminder",
	"slot_claimed_confirmation",
	"open_slots_digest",
]);
export const notificationChannelEnum = pgEnum("notification_channel", [
	"email",
]);

export const notifications = pgTable(
	"notifications",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// Recipient is a Membership (self-serve roster model): most members have
		// no sign-in account; email resolves member.email ?? person.email at send
		// time.
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		// slot-scoped (reminder/confirmation) or meeting-scoped (digest); at
		// least one must be set.
		slotId: uuid("slot_id").references(() => roleSlots.id, {
			onDelete: "cascade",
		}),
		meetingId: uuid("meeting_id").references(() => meetings.id, {
			onDelete: "cascade",
		}),
		type: notificationTypeEnum("type").notNull(),
		channel: notificationChannelEnum("channel").notNull().default("email"),
		sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
		sentAt: timestamp("sent_at", { withTimezone: true }),
	},
	(t) => [
		// Poller scan: pending-only partial index (design doc §7c).
		index("notifications_pending_idx")
			.on(t.sendAt)
			.where(sql`${t.sentAt} IS NULL`),
		check(
			"notifications_target_check",
			sql`${t.slotId} IS NOT NULL OR ${t.meetingId} IS NOT NULL`,
		),
	],
);
```

(Import `check` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm` if
not present; follow the existing index/check style in this file — e.g.
`activity_log_club_created_idx` at line 569.) Update
`notificationsRelations` (line ~677) to point at `members`/`roleSlots`/
`meetings` instead of `user`.

Then `bun run db:generate`. Inspect the generated SQL: because the old
columns are dropped, drizzle may emit destructive ALTERs — that is expected
and safe **only because the table is empty** (STOP condition 1). Add a header
comment to the migration noting it assumes an empty table. Apply with
`bun run db:migrate`.

**Verify**: `bun run db:generate` produces no FURTHER migration (schema and
files in sync); `bunx tsc --noEmit` → exit 0.

### Step 2: Notification write helpers (`src/server/notifications-logic.ts`)

New module, all functions taking a `DbOrTx` first arg (copy the `DbOrTx` type
pattern from `speeches-logic.ts`). Implement:

- `scheduleClaimNotifications(conn, { slotId, memberId, meetingId, meetingScheduledAt })`
  — inserts `slot_claimed_confirmation` (`sendAt: new Date()`) and, **only if**
  `meetingScheduledAt - 24h > now`, `slot_reminder`
  (`sendAt: meetingScheduledAt - 24h`).
- `cancelPendingForSlot(conn, slotId)` — deletes rows for the slot where
  `sentAt IS NULL`.
- `scheduleMeetingDigests(conn, { meetingId, clubId, meetingScheduledAt })` —
  one meeting-level `open_slots_digest` row per active admin member
  (`members WHERE clubId = … AND clubRole = 'admin' AND status = 'active'`),
  `sendAt: meetingScheduledAt - 72h`, only when that is in the future.
- `shiftPendingForMeeting(conn, { meetingId, oldScheduledAt, newScheduledAt })`
  — for pending rows of this meeting (digest rows by `meetingId`; reminder
  rows by joining the meeting's slots), `sendAt += (new - old)`.
- `cancelPendingForMeeting(conn, meetingId)` — deletes pending rows for the
  meeting and all its slots.

Timestamps are plain UTC arithmetic on `meetings.scheduledAt` (already a UTC
instant); club timezone matters only for display in templates (Step 5).

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 3: Wire the write points (inside the existing transactions)

- `claimSlot` (`src/server/slots.ts`, tx starting line 67): after the
  conditional UPDATE succeeds, call `scheduleClaimNotifications(tx, …)` — the
  handler already has the slot row with its `meetingId`; it needs the
  meeting's `scheduledAt` (extend the existing pre-read join or fetch in-tx).
- `releaseSlot` (line 120): call `cancelPendingForSlot(tx, slotId)` inside its
  write transaction.
- `reassignSlot` (line 298 / or `reassignSlotCore` post-014): 
  `cancelPendingForSlot` then `scheduleClaimNotifications` for the new member.
- `createMeeting` (via `meetings-logic.ts` create path): after slots are
  generated, `scheduleMeetingDigests(tx, …)`.
- `applyMeetingUpdate` (`meetings-logic.ts:83`): in the schedule-change branch
  (line ~113), `shiftPendingForMeeting`; in the cancel branch,
  `cancelPendingForMeeting`.

Import from `./notifications-logic` — imports of `-logic` modules inside
server-fn modules are the established pattern; the guard test checks
*exports*, not imports.

**Verify**: `bun run check` + `bunx tsc --noEmit` → exit 0;
`TEST_DATABASE_URL=… bun run test` → existing suites still green (claim/
release/meeting-manage integration tests must not break).

### Step 4: Poller logic (`src/server/notification-poller-logic.ts`)

```ts
export interface PollerDeps {
	send: typeof sendEmail; // injected for tests
	now?: () => Date;
}
export async function pollOnce(deps: PollerDeps): Promise<{ sent: number; skipped: number; failed: number }>
```

Behavior per due row (`sendAt <= now AND sentAt IS NULL`, `ORDER BY sendAt`,
`LIMIT 100`):

1. **Atomic claim first** (design doc §4b, at-most-once):
   `UPDATE notifications SET sent_at = now() WHERE id = $id AND sent_at IS NULL RETURNING *` —
   drizzle `.update().set({sentAt}).where(and(eq(id), isNull(sentAt))).returning()`;
   zero rows → another tick owns it, skip.
2. Resolve context: member (+ person for email fallback), slot + role name +
   meeting, or meeting + open-slot count for digests.
3. Recipient email = `member.email ?? person.email`; none → count as
   `skipped`, log `[notifications] no email for member <id>`, leave the row
   marked sent (it can never succeed later).
4. Digest rows: compute the meeting's CURRENT open slots; zero open → skipped
   (marked sent, nothing to nudge about). Cancelled meeting → skipped.
5. Build the template (Step 5) and `await deps.send(...)`; a throw → count
   `failed`, log with member id (never log email bodies — the magic-link rule
   about not logging bearer URLs sets the precedent for log hygiene).

Export also `startNotificationPoller(): void` that guards double-start via a
`globalThis` symbol (vite dev re-imports modules) and `setInterval(pollOnce…, 60_000)`
with an immediate first tick, catching and logging all errors (`[notifications]`
prefix) so a bad tick never crashes the interval.

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 5: Templates (`src/lib/notification-emails.ts`)

Model the module + test after `src/lib/magic-link-email.ts` and its test.
Three builders returning `{ subject, html, text }`:

- `buildSlotReminderEmail({ roleName, meetingTheme, meetingDate, clubName, timezone })`
- `buildClaimConfirmationEmail({ ... same shape ... })`
- `buildOpenSlotsDigestEmail({ clubName, meetingDate, timezone, openRoles: string[] })`

Format `meetingDate` in the **club timezone** with `Intl.DateTimeFormat`
(existing pattern: `src/lib/agenda-timing.ts` / `src/lib/datetime.ts` — reuse
a helper if one fits rather than re-implementing). Plain inline HTML strings,
no template system.

**Verify**: `bunx vitest run src/lib/notification-emails.test.ts` → pass.

### Step 6: Start the poller at server boot

Create `src/server-plugins/notification-poller.ts`:

```ts
import { defineNitroPlugin } from "nitro/runtime";
import { startNotificationPoller } from "#/server/notification-poller-logic";

export default defineNitroPlugin(() => {
	startNotificationPoller();
	console.log("[notifications] poller started");
});
```

Register it — attempt (A): in `vite.config.ts`,
`nitro({ plugins: ["./src/server-plugins/notification-poller.ts"], rollupConfig: … })`.
Build and boot: `bun run build` then (with `.env.local`'s DATABASE_URL
exported) `node .output/server/index.mjs` — the boot log must show
`[notifications] poller started`. If (A) doesn't register, attempt (B): move
the file to `server/plugins/notification-poller.ts` (repo root — Nitro's
scanned dir; keep the `#/server/...` import; adjust tsconfig include if
typecheck misses it). If neither mechanism fires the log line, STOP.

Also confirm `bun run dev` still starts cleanly and the poller logs once (not
per HMR reload — the `globalThis` guard).

**Verify**: boot log line present in BOTH `bun run dev` and the built server;
`curl localhost:3000/api/health` → 200 while the poller runs.

### Step 7: End-to-end smoke (dev transport)

With the dev server running against the dev DB (no `RESEND_API_KEY` → emails
print to console): claim a slot in a meeting <24h away via the UI or a seed
script, wait one poller tick, and confirm the console shows the
`[email:dev] to=…` confirmation send and the row's `sentAt` is set
(`docker exec dev-postgres psql -U dev -d tm_scheduler -c "SELECT type, sent_at IS NOT NULL AS sent FROM notifications;"`).

**Verify**: console output + query result captured in your report.

### Step 8: Full gate

**Verify**: `bun run check`, `bunx tsc --noEmit`,
`TEST_DATABASE_URL=… bun run test`, `bun run build` → all exit 0;
`bun run db:generate` produces no new migration.

## Test plan

`src/server/notifications.integration.test.ts` (pattern:
`speeches.integration.test.ts` — `describe.skipIf(!hasTestDb)`, testDb
fixtures):

1. `scheduleClaimNotifications` inserts confirmation (+ reminder only when
   >24h out; not when the meeting is sooner).
2. `cancelPendingForSlot` removes pending rows but never rows with `sentAt`
   set.
3. `scheduleMeetingDigests` inserts one row per active admin, none for
   `member`-role or inactive members.
4. `shiftPendingForMeeting` moves pending `sendAt` by the exact delta;
   sent rows untouched.
5. `cancelPendingForMeeting` clears pending rows for the meeting AND its
   slots' reminders.
6. `pollOnce` with an injected fake `send`: (a) sends due rows and marks
   `sentAt`; (b) a second `pollOnce` sends nothing (at-most-once); (c) a
   member with no email → skipped, marked sent; (d) digest for a meeting
   whose slots all got claimed → skipped; (e) `send` throwing → counted
   failed, row stays marked (documented at-most-once trade-off).
7. Check constraint: inserting a row with neither `slotId` nor `meetingId`
   rejects.

`src/lib/notification-emails.test.ts`: each builder returns non-empty
subject/html/text; date renders in the passed timezone (assert on a known
timestamp, e.g. `America/Los_Angeles` vs `UTC` differ).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run check`, `bunx tsc --noEmit`, `bun run build` exit 0
- [ ] `TEST_DATABASE_URL=… bun run test` exits 0; the 7 integration cases + template tests exist and pass
- [ ] `bun run db:generate` emits no new migration (schema ↔ migrations in sync)
- [ ] `grep -rn "user_id" src/db/schema.ts` shows NO hit inside the notifications table definition
- [ ] `grep -n "notifications_pending_idx" drizzle/*.sql` → present with `WHERE`
- [ ] Boot log `[notifications] poller started` appears for the built server (Step 6 evidence)
- [ ] Step 7 smoke evidence captured (console send + `sent_at` set)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **The production `notifications` table has rows.** Before Step 1, ask the
  operator to run `SELECT count(*) FROM notifications;` in prod (you cannot).
  If you cannot get confirmation, say so in your report and proceed only with
  the local/dev DBs — flag the prod migration as needing that check at deploy
  time.
- Meeting cancel is NOT handled inside `applyMeetingUpdate` (you can't find
  the status→cancelled branch there) — the cancel write point needs a
  different home; report where cancel actually happens.
- Neither Nitro plugin mechanism (Step 6 A/B) produces the boot log — poller
  wiring needs operator input on the Nitro version's plugin API; do not
  invent a third mechanism (e.g. route-module side effects — those leak into
  the client bundle, the exact regression `server-modules.guard.test.ts`
  exists to prevent).
- The generated migration contains anything beyond the notifications table +
  enums + index/check (unexpected schema drift).
- Plan 014's refactor of `reassignSlot` is half-landed (both shapes present).

## Maintenance notes

- **Deploy note for the operator**: first deploy after this plan applies a
  destructive reshape of `notifications` — confirm the prod table is empty
  (it should be; no code has ever written it).
- The at-most-once trade-off (crash between mark and send drops one email) is
  a documented decision (design doc §4b) — do not "fix" it to at-least-once
  without revisiting that section.
- Write-point wiring inside server-fn handlers is untestable by convention
  (handlers can't run in tests); the logic helpers carry the coverage. When a
  new slot/meeting mutation path is added (e.g. swap matching), it MUST call
  the matching notifications-logic helper — reviewers should check this.
- `docs/design/reminders.md` §6 is superseded by this plan's member-keyed
  model (plan 016 adds the pointer note).
- Future: the "Remind unfilled" button can insert an immediate
  `open_slots_digest`-style row; multi-instance deployment would need the
  poller's atomic claim (already correct) plus jitter.
