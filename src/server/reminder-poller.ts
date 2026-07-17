// In-process reminder poller (#271). A long-running interval on the single Node
// server (ADR-0007 / ADR-0023 — NOT edge/serverless/cron) that drains DUE
// `notifications` rows each tick via `processDueNotifications`. Started once at
// server boot by the Nitro plugin (`reminder-poller.nitro.ts`).
//
// Server-only: imports `#/db` transitively (via notifications-logic). It is
// referenced solely from the Nitro plugin — never from a client route — so it
// stays out of the client bundle.
import { processDueNotifications } from "./notifications-logic";

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
 * Run one poll tick. Overlap guard: if the previous tick is still in flight when
 * the interval fires (a slow send batch), skip this one so ticks never stack up
 * in the single process. A thrown error is logged and swallowed — the poller
 * must survive a bad tick and keep running.
 */
async function tick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		const result = await processDueNotifications();
		if (result.due > 0) {
			console.log(
				`[reminders] tick: due=${result.due} sent=${result.sent} failed=${result.failed} skipped=${result.skipped} suppressed=${result.suppressed}`,
			);
		}
	} catch (err) {
		console.error("[reminders] poll tick failed:", err);
	} finally {
		ticking = false;
	}
}

/**
 * Start the poller. Idempotent — a second call while running is a no-op. Set
 * `DISABLE_REMINDER_POLLER=1` to opt out (e.g. a worker that shouldn't send).
 * Returns whether it started.
 */
export function startReminderPoller(): boolean {
	if (timer) return false;
	if (process.env.DISABLE_REMINDER_POLLER === "1") {
		console.log("[reminders] poller disabled via DISABLE_REMINDER_POLLER");
		return false;
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
