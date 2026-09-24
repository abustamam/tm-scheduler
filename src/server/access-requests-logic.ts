// The public request-access form's write path (#866): bot filters, caps, the
// insert, the cap-trip alert, and — on the poller (ADR-0023) — delivery of the
// maintainer's emails and the retention sweep.
//
// SESSION-LESS and anonymous, and it mints PII (a name and an email), so it sits
// in the same risk class as `captureGuestVisit`. What bounds it:
//   - a honeypot and a minimum fill time, measured on the client;
//   - a per-email cap, a global cap, and a separate cap on how many requests
//     the maintainer is emailed about, all counted and written under ONE
//     transaction-scoped advisory lock, so concurrent submissions cannot
//     overshoot them;
//   - one alert per UTC day when any cap trips, not one per rejection.
// There is no per-IP cap: see the PR for #866 — the client IP Railway hands
// the app could not be verified as unspoofable.
//
// Imported only by `access-requests.ts` (a server-fn module), the poller, and
// tests, so `#/db` never reaches the client bundle.
import { and, count, eq, gt, isNull, like, lt, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { accessRequestAlerts, accessRequests } from "#/db/schema";
import { ACCESS_REQUEST_NOTIFY_EMAIL } from "#/lib/brand";
import { escapeHtml, toSubjectText } from "#/lib/html-escape";
import type { AccessRequestInput } from "./access-requests-schemas";
import {
	defaultNotificationDeps,
	MAX_SEND_ATTEMPTS,
	type NotificationDeps,
	RETRY_BACKOFF_MS,
} from "./notifications-logic";

export type AccessRequestLimits = {
	/** A form submitted sooner than this after it opened is a bot. */
	minFillMs: number;
	/** At this many rows for one email in 24h, the next is "already received". */
	perEmail24h: number;
	/** At this many rows in 24h overall, the next is refused as "busy". */
	global24h: number;
	/** At this many notified rows in 24h, a new row is saved but not emailed. */
	notify24h: number;
};

/**
 * The production caps. `access-requests.integration.test.ts` pins these four
 * LITERALS in one test and drives the behaviour with small injected limits in
 * the rest, so a bound is never asserted in terms of the number it constrains.
 */
export const LIMITS: AccessRequestLimits = {
	minFillMs: 3000,
	perEmail24h: 3,
	global24h: 200,
	notify24h: 40,
};

/** Rows older than this are deleted by the poller's sweep. */
export const ACCESS_REQUEST_RETENTION_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The advisory-lock key every submission serialises on. One key, not one per
 * email: the global and notification caps are table-wide, so a per-email key
 * would still let two different emails race past them.
 */
const LOCK_KEY = "access-requests:submit";

export type CapReason = "per_email" | "global" | "notify";

export type SubmitAccessRequestResult =
	| { ok: true; alreadyReceived?: true }
	| { ok: false; reason: "busy" };

/**
 * TEST-ONLY seams. Production passes nothing.
 *
 * - `emailLike` narrows the global and notification counts (and the poller's
 *   delivery and sweep) to rows whose email matches this LIKE pattern, so a
 *   suite seeding rows under its own per-run domain is isolated from every
 *   other row in the shared `tm_test`.
 * - `alertKey` prefixes the alert window key for the same reason: the real key
 *   is the UTC day, which every parallel suite would otherwise share.
 */
export type AccessRequestScope = { emailLike?: string; alertKey?: string };

export type SubmitAccessRequestOptions = {
	now?: Date;
	limits?: AccessRequestLimits;
	scope?: AccessRequestScope;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The alert window a trip at `now` belongs to: the UTC day. */
export function alertWindowKey(now: Date, scope?: AccessRequestScope): string {
	const day = now.toISOString().slice(0, 10);
	return scope?.alertKey ? `${scope.alertKey}:${day}` : day;
}

/**
 * Record that a cap tripped. The FIRST trip in a window inserts the alert the
 * poller will send; every later one only bumps `trips`, so the maintainer gets
 * one email per window however many requests were turned away.
 */
async function recordCapTrip(
	tx: Tx,
	reason: CapReason,
	now: Date,
	scope?: AccessRequestScope,
): Promise<void> {
	await tx
		.insert(accessRequestAlerts)
		.values({ windowKey: alertWindowKey(now, scope), firstReason: reason })
		.onConflictDoUpdate({
			target: accessRequestAlerts.windowKey,
			set: { trips: sql`${accessRequestAlerts.trips} + 1` },
		});
}

/**
 * Handle one validated submission. The order is the contract:
 *
 * 1. honeypot filled → silent `{ ok: true }`, nothing written or sent;
 * 2. form open for less than `minFillMs` → the same silence;
 * 3. per-email cap reached → `{ ok: true, alreadyReceived: true }`, no write;
 * 4. global cap reached → `{ ok: false, reason: "busy" }`, no write;
 * 5. insert the row, CLAIMING a notification slot (`notified = true`) if the
 *    day's notification cap has room.
 *
 * Steps 3-5 run in one transaction under `pg_advisory_xact_lock`, so they are
 * one atomic check-then-write: concurrent submissions queue on the lock and each
 * counts the rows the previous one committed. Nothing here sends email — the
 * poller delivers claimed rows, so a Resend failure is retried rather than lost.
 * Any cap trip in 3-5 also records the window's alert, inside the same lock.
 */
export async function submitAccessRequestLogic(
	input: AccessRequestInput,
	{ now = new Date(), limits = LIMITS, scope }: SubmitAccessRequestOptions = {},
): Promise<SubmitAccessRequestResult> {
	// 1–2. Bots get exactly what a person gets, so neither filter is a signal.
	if (input.trap !== "") return { ok: true };
	if (input.fillMs < limits.minFillMs) return { ok: true };

	const since = new Date(now.getTime() - DAY_MS);
	const inWindow = gt(accessRequests.createdAt, since);
	const scoped = scope?.emailLike
		? like(accessRequests.email, scope.emailLike)
		: undefined;

	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`,
		);

		// 3. Per-email cap. Email is already lowercased + trimmed by the schema.
		const [perEmail] = await tx
			.select({ n: count() })
			.from(accessRequests)
			.where(and(inWindow, eq(accessRequests.email, input.email)));
		if ((perEmail?.n ?? 0) >= limits.perEmail24h) {
			await recordCapTrip(tx, "per_email", now, scope);
			return { ok: true, alreadyReceived: true } as const;
		}

		// 4. Global cap.
		const [global] = await tx
			.select({ n: count() })
			.from(accessRequests)
			.where(and(inWindow, scoped));
		if ((global?.n ?? 0) >= limits.global24h) {
			await recordCapTrip(tx, "global", now, scope);
			return { ok: false, reason: "busy" } as const;
		}

		// 5. Claim a notification slot, then insert. Fields that belong to the
		//    other kind are dropped, so a row only carries what its form asked.
		const [claimed] = await tx
			.select({ n: count() })
			.from(accessRequests)
			.where(and(inWindow, scoped, eq(accessRequests.notified, true)));
		const notified = (claimed?.n ?? 0) < limits.notify24h;
		if (!notified) await recordCapTrip(tx, "notify", now, scope);

		const isClub = input.kind === "club";
		await tx.insert(accessRequests).values({
			kind: input.kind,
			name: input.name,
			email: input.email,
			clubName: isClub ? (input.clubName ?? null) : null,
			clubNumber: isClub ? (input.clubNumber ?? null) : null,
			districtNumber: isClub ? null : (input.districtNumber ?? null),
			message: input.message ?? null,
			ref: input.ref,
			notified,
		});
		return { ok: true } as const;
	});
}

// ---------------------------------------------------------------------------
// Delivery (the poller, ADR-0023). Same claim / backoff / bounded-retry shape
// as `processDueNotifications`, and the same two constants.
// ---------------------------------------------------------------------------

export type AccessRequestDeliveryResult = {
	sent: number;
	failed: number;
	alertsSent: number;
	alertsFailed: number;
};

const errorText = (err: unknown) =>
	(err instanceof Error ? err.message : String(err)).slice(0, 1000);

/**
 * Send every claimed-but-unsent request notification and every unsent alert.
 * Each row is claimed by bumping its attempts counter from the value read, so
 * two overlapping ticks cannot both send it; a failure records the error and
 * leaves the row for a retry after `RETRY_BACKOFF_MS`, up to `MAX_SEND_ATTEMPTS`.
 * Never throws for a single row's failure.
 */
export async function deliverAccessRequestMail(
	deps: NotificationDeps = defaultNotificationDeps,
	{ limit = 50, scope }: { limit?: number; scope?: AccessRequestScope } = {},
): Promise<AccessRequestDeliveryResult> {
	const result = { sent: 0, failed: 0, alertsSent: 0, alertsFailed: 0 };
	const now = deps.now();
	const retryBefore = new Date(now.getTime() - RETRY_BACKOFF_MS);

	const due = await db
		.select()
		.from(accessRequests)
		.where(
			and(
				eq(accessRequests.notified, true),
				isNull(accessRequests.notifySentAt),
				lt(accessRequests.notifyAttempts, MAX_SEND_ATTEMPTS),
				or(
					isNull(accessRequests.notifyLastAttemptedAt),
					lt(accessRequests.notifyLastAttemptedAt, retryBefore),
				),
				scope?.emailLike
					? like(accessRequests.email, scope.emailLike)
					: undefined,
			),
		)
		.orderBy(accessRequests.createdAt)
		.limit(limit);

	for (const row of due) {
		const won = await db
			.update(accessRequests)
			.set({
				notifyAttempts: row.notifyAttempts + 1,
				notifyLastAttemptedAt: now,
			})
			.where(
				and(
					eq(accessRequests.id, row.id),
					isNull(accessRequests.notifySentAt),
					eq(accessRequests.notifyAttempts, row.notifyAttempts),
				),
			)
			.returning({ id: accessRequests.id });
		if (won.length === 0) continue;
		try {
			await deps.sendEmail({
				to: ACCESS_REQUEST_NOTIFY_EMAIL,
				replyTo: row.email,
				...buildAccessRequestEmail(row),
			});
			await db
				.update(accessRequests)
				.set({ notifySentAt: deps.now(), notifyLastError: null })
				.where(eq(accessRequests.id, row.id));
			result.sent++;
		} catch (err) {
			await db
				.update(accessRequests)
				.set({ notifyLastError: errorText(err) })
				.where(eq(accessRequests.id, row.id));
			// The id only: the row holds the PII, and the log need not repeat it.
			console.error(
				`[access-requests] notification failed for request ${row.id}:`,
				err,
			);
			result.failed++;
		}
	}

	const alerts = await db
		.select()
		.from(accessRequestAlerts)
		.where(
			and(
				isNull(accessRequestAlerts.sentAt),
				lt(accessRequestAlerts.attempts, MAX_SEND_ATTEMPTS),
				or(
					isNull(accessRequestAlerts.lastAttemptedAt),
					lt(accessRequestAlerts.lastAttemptedAt, retryBefore),
				),
				scope?.alertKey
					? like(accessRequestAlerts.windowKey, `${scope.alertKey}:%`)
					: undefined,
			),
		)
		.limit(limit);

	for (const alert of alerts) {
		const won = await db
			.update(accessRequestAlerts)
			.set({ attempts: alert.attempts + 1, lastAttemptedAt: now })
			.where(
				and(
					eq(accessRequestAlerts.id, alert.id),
					isNull(accessRequestAlerts.sentAt),
					eq(accessRequestAlerts.attempts, alert.attempts),
				),
			)
			.returning({ id: accessRequestAlerts.id });
		if (won.length === 0) continue;
		try {
			await deps.sendEmail({
				to: ACCESS_REQUEST_NOTIFY_EMAIL,
				...buildCapAlertEmail(alert),
			});
			await db
				.update(accessRequestAlerts)
				.set({ sentAt: deps.now(), lastError: null })
				.where(eq(accessRequestAlerts.id, alert.id));
			result.alertsSent++;
		} catch (err) {
			await db
				.update(accessRequestAlerts)
				.set({ lastError: errorText(err) })
				.where(eq(accessRequestAlerts.id, alert.id));
			console.error(`[access-requests] cap alert failed for ${alert.id}:`, err);
			result.alertsFailed++;
		}
	}

	return result;
}

/**
 * Retention (#866): delete requests, and alerts, older than
 * `ACCESS_REQUEST_RETENTION_DAYS`. Runs on the poller's sweep, which runs even
 * when delivery is disabled. Erasure on request is a manual delete by email.
 */
export async function sweepExpiredAccessRequests(
	now: Date = new Date(),
	scope?: AccessRequestScope,
): Promise<{ requests: number; alerts: number }> {
	const cutoff = new Date(
		now.getTime() - ACCESS_REQUEST_RETENTION_DAYS * DAY_MS,
	);
	const requests = await db
		.delete(accessRequests)
		.where(
			and(
				lt(accessRequests.createdAt, cutoff),
				scope?.emailLike
					? like(accessRequests.email, scope.emailLike)
					: undefined,
			),
		)
		.returning({ id: accessRequests.id });
	const alerts = await db
		.delete(accessRequestAlerts)
		.where(
			and(
				lt(accessRequestAlerts.createdAt, cutoff),
				scope?.alertKey
					? like(accessRequestAlerts.windowKey, `${scope.alertKey}:%`)
					: undefined,
			),
		)
		.returning({ id: accessRequestAlerts.id });
	return { requests: requests.length, alerts: alerts.length };
}

// ---------------------------------------------------------------------------
// Email bodies.
// ---------------------------------------------------------------------------

type AccessRequestRow = typeof accessRequests.$inferSelect;
type AccessRequestAlertRow = typeof accessRequestAlerts.$inferSelect;

/**
 * The maintainer's notification. Every value came from an anonymous form, so
 * each one is escaped in the html body and stripped of control characters in
 * the subject; the text body is plain text and needs neither.
 */
export function buildAccessRequestEmail(row: AccessRequestRow): {
	subject: string;
	html: string;
	text: string;
} {
	const subject =
		row.kind === "club"
			? `GavelUp access request: ${toSubjectText(row.clubName ?? "(no club name)")}`
			: `GavelUp district request: District ${toSubjectText(row.districtNumber ?? "?")}`;

	const fields: Array<[string, string | null]> = [
		["Kind", row.kind],
		["Name", row.name],
		["Email", row.email],
		...(row.kind === "club"
			? ([
					["Club name", row.clubName],
					["Club number", row.clubNumber],
				] as Array<[string, string | null]>)
			: ([["District", row.districtNumber]] as Array<[string, string | null]>)),
		["Message", row.message],
		["Ref", row.ref],
		["Received", row.createdAt.toISOString()],
	];

	const text = [
		subject,
		"",
		...fields.map(([label, value]) => `${label}: ${value ?? "(none)"}`),
		"",
		"Reply to this email to answer the requester directly.",
	].join("\n");

	const rows = fields
		.map(
			([label, value]) =>
				`<tr><th align="left" style="padding:4px 12px 4px 0;vertical-align:top;">${escapeHtml(label)}</th><td style="padding:4px 0;white-space:pre-wrap;">${value === null ? "<em>(none)</em>" : escapeHtml(value)}</td></tr>`,
		)
		.join("");
	const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <h1 style="font-size:18px;">${escapeHtml(subject)}</h1>
    <table style="font-size:14px;border-collapse:collapse;">${rows}</table>
    <p style="font-size:13px;color:#52525b;">Reply to this email to answer the requester directly.</p>
  </body>
</html>`;

	return { subject, html, text };
}

const REASON_TEXT: Record<string, string> = {
	per_email: "one address asked more times than the per-email cap allows",
	global: "the form reached its daily cap and started answering “busy”",
	notify:
		"more requests arrived than the daily email cap; the rest are saved but were not emailed",
};

/** The once-per-window cap alert. Carries no requester data, only counts. */
export function buildCapAlertEmail(alert: AccessRequestAlertRow): {
	subject: string;
	html: string;
	text: string;
} {
	const why = REASON_TEXT[alert.firstReason] ?? alert.firstReason;
	const subject = "GavelUp: the request-access form hit a cap";
	const lines = [
		`Window: ${alert.windowKey} (UTC)`,
		`First cap to trip: ${alert.firstReason} (${why})`,
		`Rejections or un-emailed requests so far this window: ${alert.trips}`,
		"",
		"You get one of these per day at most. Read the rows with:",
		"select * from access_requests order by created_at desc limit 50;",
	];
	const text = lines.join("\n");
	const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <h1 style="font-size:18px;">${escapeHtml(subject)}</h1>
    <pre style="font-size:13px;white-space:pre-wrap;">${escapeHtml(text)}</pre>
  </body>
</html>`;
	return { subject, html, text };
}
