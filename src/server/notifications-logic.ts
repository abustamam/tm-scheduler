// Reminder delivery foundation (#271). The directly-testable DB logic behind
// the in-process poller (`reminder-poller.ts`): select DUE `notifications`
// rows, claim each exactly once, and deliver it through the email transport.
//
// This is the SEND half only — producers that enqueue rows are separate
// (#272 role reminders, #274 preferences/unsubscribe). `enqueueNotification`
// here is a minimal internal helper so tests (and, later, producers) can put
// rows on the queue.
//
// It lives in a `*-logic.ts` (not a createServerFn module) so it is
// integration-testable against a test db and NEVER pulled into the client
// bundle — see `CLAUDE.md` "Data layer" and `members-logic.ts` for the split.
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	notifications,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import type { SendEmailParams } from "#/lib/email";
import { sendEmail as realSendEmail } from "#/lib/email";
import { formatMeetingDate } from "#/lib/format";

/** Give up on a row after this many failed attempts (bounded retry). */
export const MAX_SEND_ATTEMPTS = 5;
/** A failed row waits at least this long before it's eligible to retry. Also
 *  keeps a just-claimed row out of the due set until the tick that claimed it
 *  finishes, so an overlapping tick can't pick it up mid-send. */
export const RETRY_BACKOFF_MS = 5 * 60_000;
/** Cap on rows processed per tick — keeps a backlog from starving a single tick. */
export const DEFAULT_BATCH_LIMIT = 100;

/**
 * Side-effecting deps, injected so the processing loop is unit-testable with a
 * mock transport and a fixed clock (mirrors `MinutesEmailDeps`). Production wires
 * the real Resend/console transport via `defaultNotificationDeps`.
 */
export interface NotificationDeps {
	sendEmail(params: SendEmailParams): Promise<void>;
	/** Injectable clock — the tick's "now" for due-selection and stamping. */
	now(): Date;
}

export const defaultNotificationDeps: NotificationDeps = {
	sendEmail: realSendEmail,
	now: () => new Date(),
};

/** A due row joined to the context needed to render its reminder email. */
export interface DueNotification {
	id: string;
	type: string;
	channel: string;
	attempts: number;
	recipientEmail: string;
	recipientName: string;
	roleName: string;
	clubName: string;
	meetingScheduledAt: Date;
}

export interface ProcessResult {
	/** Rows selected as due this tick. */
	due: number;
	/** Rows successfully delivered (`sent_at` set). */
	sent: number;
	/** Rows a delivery attempt failed on (left unsent for a bounded retry). */
	failed: number;
	/** Rows skipped for an unsupported channel (recorded as an error). */
	skipped: number;
}

// ---------------------------------------------------------------------------
// Email content — a PURE builder. The row carries no stored subject/body, so
// the foundation renders a sensible role reminder from the joined slot context.
// Producers (#272) may enrich the copy later; delivery does not depend on it.
// ---------------------------------------------------------------------------

export interface NotificationEmailContent {
	subject: string;
	html: string;
	text: string;
}

export function buildNotificationEmail(row: {
	recipientName: string;
	roleName: string;
	clubName: string;
	meetingScheduledAt: Date;
}): NotificationEmailContent {
	const when = formatMeetingDate(row.meetingScheduledAt);
	const subject = `Reminder: you're ${row.roleName} at ${row.clubName} on ${when}`;

	const text = [
		`Hi ${row.recipientName},`,
		"",
		`This is a reminder that you're signed up as ${row.roleName} for ${row.clubName}'s meeting on ${when}.`,
		"",
		"See you there!",
		row.clubName,
	].join("\n");

	const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;">
  <p>Hi ${escapeHtml(row.recipientName)},</p>
  <p>This is a reminder that you're signed up as <strong>${escapeHtml(row.roleName)}</strong> for ${escapeHtml(row.clubName)}'s meeting on <strong>${escapeHtml(when)}</strong>.</p>
  <p>See you there!<br>${escapeHtml(row.clubName)}</p>
</div>`;

	return { subject, html, text };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Queue helpers.
// ---------------------------------------------------------------------------

export interface EnqueueNotificationInput {
	userId: string;
	slotId: string;
	type: string;
	sendAt: Date;
	/** Delivery channel; defaults to `email` (the only wired channel today). */
	channel?: string;
}

/**
 * Minimal internal enqueue helper: put one reminder row on the queue. Exists so
 * tests (and future producers) have a supported way to enqueue; the poller reads
 * whatever is due regardless of who wrote it.
 */
export async function enqueueNotification(
	input: EnqueueNotificationInput,
): Promise<string> {
	const [row] = await db
		.insert(notifications)
		.values({
			userId: input.userId,
			slotId: input.slotId,
			type: input.type,
			channel: input.channel ?? "email",
			sendAt: input.sendAt,
		})
		.returning({ id: notifications.id });
	if (!row) throw new Error("Failed to enqueue notification.");
	return row.id;
}

/**
 * Select DUE rows: `send_at <= now` AND `sent_at IS NULL`, under the retry
 * budget, and either never attempted or past the retry backoff. Joined to the
 * recipient (user) + slot context needed to render the email. Oldest-due first.
 */
export async function selectDueNotifications(
	now: Date,
	limit: number,
): Promise<DueNotification[]> {
	const retryReady = new Date(now.getTime() - RETRY_BACKOFF_MS);
	return db
		.select({
			id: notifications.id,
			type: notifications.type,
			channel: notifications.channel,
			attempts: notifications.attempts,
			recipientEmail: user.email,
			recipientName: user.name,
			roleName: roleDefinitions.name,
			clubName: clubs.name,
			meetingScheduledAt: meetings.scheduledAt,
		})
		.from(notifications)
		.innerJoin(user, eq(user.id, notifications.userId))
		.innerJoin(roleSlots, eq(roleSlots.id, notifications.slotId))
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(
			and(
				lte(notifications.sendAt, now),
				isNull(notifications.sentAt),
				lt(notifications.attempts, MAX_SEND_ATTEMPTS),
				or(
					isNull(notifications.lastAttemptedAt),
					lte(notifications.lastAttemptedAt, retryReady),
				),
			),
		)
		.orderBy(asc(notifications.sendAt))
		.limit(limit);
}

/**
 * Atomically claim a due row for THIS tick: bump `attempts` (the optimistic-lock
 * token) and stamp `last_attempted_at`, conditional on the row still being
 * unsent AND its attempts unchanged since we read it. This conditional UPDATE is
 * the at-most-once guard (mirrors the ADR-0005 slot claim): under concurrent
 * ticks exactly one UPDATE matches the row — the loser affects zero rows and
 * skips, so a row is never delivered twice. Returns true iff we won the claim.
 */
async function claimNotification(
	id: string,
	expectedAttempts: number,
	now: Date,
): Promise<boolean> {
	const claimed = await db
		.update(notifications)
		.set({ attempts: expectedAttempts + 1, lastAttemptedAt: now })
		.where(
			and(
				eq(notifications.id, id),
				isNull(notifications.sentAt),
				eq(notifications.attempts, expectedAttempts),
			),
		)
		.returning({ id: notifications.id });
	return claimed.length > 0;
}

/** Mark a claimed row delivered — sets `sent_at`, clears any prior error. */
async function markSent(id: string, now: Date): Promise<void> {
	await db
		.update(notifications)
		.set({ sentAt: now, lastError: null })
		.where(eq(notifications.id, id));
}

/** Record a delivery failure on a claimed row; leaves `sent_at` NULL so the
 *  bounded retry can pick it up again after the backoff. */
async function recordFailure(id: string, message: string): Promise<void> {
	await db
		.update(notifications)
		.set({ lastError: message.slice(0, 1000) })
		.where(eq(notifications.id, id));
}

/**
 * Process one batch of due notifications: for each due row, claim it (at-most-
 * once), route by `channel`, deliver, and mark the outcome. Delivery failures
 * are logged and left unsent for a bounded retry; they never abort the batch.
 * Idempotent and safe to run concurrently — the claim guard resolves overlap.
 */
export async function processDueNotifications(
	deps: NotificationDeps = defaultNotificationDeps,
	limit: number = DEFAULT_BATCH_LIMIT,
): Promise<ProcessResult> {
	const now = deps.now();
	const due = await selectDueNotifications(now, limit);

	let sent = 0;
	let failed = 0;
	let skipped = 0;

	for (const row of due) {
		// Claim before sending — the loser of a concurrent claim skips here.
		const won = await claimNotification(row.id, row.attempts, now);
		if (!won) continue;

		// Route by channel. Only `email` is wired in this foundation (#271); an
		// unknown channel is recorded as an error (the attempts bump already spent
		// one of its retry budget, so it won't loop forever).
		if (row.channel !== "email") {
			await recordFailure(row.id, `unsupported channel: ${row.channel}`);
			skipped++;
			continue;
		}

		try {
			const email = buildNotificationEmail(row);
			await deps.sendEmail({ to: row.recipientEmail, ...email });
			await markSent(row.id, deps.now());
			sent++;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await recordFailure(row.id, message);
			console.error(`[reminders] delivery failed for ${row.id}:`, err);
			failed++;
		}
	}

	return { due: due.length, sent, failed, skipped };
}
