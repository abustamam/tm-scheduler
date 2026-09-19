// In-process reminder poller (#271). A long-running interval on the single Node
// server (ADR-0007 / ADR-0023 — NOT edge/serverless/cron) that drains DUE
// `notifications` rows each tick via `processDueNotifications`. Started once at
// server boot by the Nitro plugin (`reminder-poller.nitro.ts`).
//
// Server-only: imports `#/db` transitively (via notifications-logic). It is
// referenced solely from the Nitro plugin — never from a client route — so it
// stays out of the client bundle.
import { sweepExpiredPendingPlans } from "./guest-book-pending-logic";
import { processDueNotifications } from "./notifications-logic";
import { produceRoleReminders } from "./role-reminders-logic";

/** Default cadence; override with `REMINDER_POLL_INTERVAL_MS`. */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

function resolveIntervalMs(): number {
	const raw = process.env.REMINDER_POLL_INTERVAL_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_POLL_INTERVAL_MS;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Run one poll tick: ENQUEUE-then-SEND, then SWEEP. First the role-reminder
 * producer (#272) tops up the queue with reminders for upcoming slot holders;
 * then the delivery loop (#271) drains everything currently due; then the
 * guest-book pending-plan sweep (#806) removes confirm links past their grace
 * window. The producer is idempotent (a partial unique index makes a re-enqueue
 * a no-op), so running it every tick is safe and needs no separate cadence. A
 * producer failure is logged but never blocks the send pass — delivery of
 * already-queued reminders must still happen, and neither blocks the sweep.
 *
 * `DISABLE_REMINDER_POLLER=1` stops the two delivery passes and NOT the sweep —
 * see `startReminderPoller`. A pending plan holds a visitor's unmasked name,
 * email and phone, and the sweep is the only thing in the system that deletes
 * one, so letting the send flag disable it turned a 48-hour retention window
 * into an indefinite one.
 *
 * Overlap guard: if the previous tick is still in flight when the interval fires
 * (a slow send batch), skip this one so ticks never stack up in the single
 * process. A thrown error is logged and swallowed — the poller must survive a
 * bad tick and keep running.
 */
async function tick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		try {
			const produced = await produceRoleReminders();
			if (produced.enqueued > 0) {
				console.log(
					`[reminders] produced: enqueued=${produced.enqueued} duplicates=${produced.duplicates} optedOut=${produced.optedOut} disabled=${produced.disabled}`,
				);
			}
		} catch (err) {
			// Never let a producer error skip the send pass below.
			console.error("[reminders] producer failed:", err);
		}

		const result = await processDueNotifications();
		if (result.due > 0) {
			console.log(
				`[reminders] tick: due=${result.due} sent=${result.sent} failed=${result.failed} skipped=${result.skipped} suppressed=${result.suppressed} stale=${result.stale}`,
			);
		}

		await sweepTick();
	} catch (err) {
		console.error("[reminders] poll tick failed:", err);
	} finally {
		ticking = false;
	}
}

/**
 * Delete guest-book pending plans past their grace window (#806).
 *
 * Its own function because it has its own lifecycle: it runs on the delivery
 * tick AND on a sweep-only timer when delivery is disabled. It is the only
 * thing that removes a row carrying a visitor's unmasked name, email and phone,
 * so "this process must not send" must not silently mean "this process must not
 * delete".
 *
 * There is NO flag to turn it off, deliberately. A switch that disables the
 * deletion of personal data is a switch that gets set for some unrelated
 * operational reason and never unset, which is precisely the bug that put this
 * function here: the sweep used to inherit `DISABLE_REMINDER_POLLER`, a flag
 * about SENDING, and a 48-hour retention window quietly became an indefinite
 * one. A second flag would be the same mistake one level down. Retention is a
 * property of this system, not a setting.
 *
 * The knob that does exist is the WINDOW — `PENDING_PLAN_TTL_MS` and
 * `PENDING_PLAN_GRACE_MS` in `src/lib/guest-book-pending.ts`. A deployment that
 * wants confirm links to live longer lengthens those; nothing wants them to
 * live forever.
 *
 * Never throws: a failure here must not look like a delivery failure or stop
 * the next tick.
 */
async function sweepTick(): Promise<void> {
	try {
		const swept = await sweepExpiredPendingPlans();
		if (swept.deleted > 0) {
			console.log(
				`[guest-book] swept ${swept.deleted} expired pending plan(s)`,
			);
		}
	} catch (err) {
		console.error("[guest-book] pending-plan sweep failed:", err);
	}
}

/**
 * The retention timer a send-disabled process still runs.
 *
 * Same interval as the delivery poller and the same `unref`, so it cannot hold
 * the process open on its own.
 */
function startSweepOnlyTimer(): boolean {
	const intervalMs = resolveIntervalMs();
	timer = setInterval(() => {
		void sweepTick();
	}, intervalMs);
	timer.unref?.();
	console.log(
		`[guest-book] retention sweep started (interval=${intervalMs}ms)`,
	);
	return true;
}

/**
 * Start the poller. Idempotent — a second call while running is a no-op. Set
 * `DISABLE_REMINDER_POLLER=1` to opt out (e.g. a worker that shouldn't send).
 * Returns whether it started.
 */
export function startReminderPoller(): boolean {
	if (timer) return false;
	if (process.env.DISABLE_REMINDER_POLLER === "1") {
		// The SWEEP still runs, and there is no way to stop it (see `sweepTick`).
		// `DISABLE_REMINDER_POLLER` says "this process must not SEND"; the
		// guest-book sweep sends nothing — it is the only thing in the system
		// that deletes a pending plan, and a pending plan holds a visitor's
		// unmasked name, email and phone. Inheriting the send flag turned a
		// 48-hour retention window into an indefinite one, with no user-facing
		// way to discard a row. A worker that should not send has every reason
		// to still sweep.
		console.log("[reminders] poller disabled via DISABLE_REMINDER_POLLER");
		return startSweepOnlyTimer();
	}
	const intervalMs = resolveIntervalMs();
	timer = setInterval(() => {
		void tick();
	}, intervalMs);
	// Don't let the interval alone hold the process open — clean shutdown wins.
	timer.unref?.();
	console.log(`[reminders] poller started (interval=${intervalMs}ms)`);
	return true;
}

/** Stop the poller (server shutdown / dev restart). Idempotent. */
export function stopReminderPoller(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}
