// In-process poller (#271, ADR-0023). A long-running interval on the single
// Node server (ADR-0007 — NOT edge/serverless/cron). Started once at server boot
// by the Nitro plugin (`reminder-poller.nitro.ts`).
//
// Each tick it delivers the request-access form's mail to the maintainer (#866)
// and runs the two retention sweeps (MCP pending plans, old access requests).
// It no longer sends role reminders: ADR-0028 removed them (#902), because a
// human sends every message to a member, guest or prospect — the app only
// drafts. The file, the plugin and `REMINDER_POLL_INTERVAL_MS` keep their names
// on purpose, so a deployment's env var still applies.
//
// Server-only: imports `#/db` transitively (via access-requests-logic). It is
// referenced solely from the Nitro plugin — never from a client route — so it
// stays out of the client bundle.
import { describePendingSweep } from "#/lib/pending-plan";
import {
	deliverAccessRequestMail,
	sweepExpiredAccessRequests,
} from "./access-requests-logic";
import { sweepExpiredPendingPlans } from "./mcp-pending-logic";

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
 * Run one poll tick: DELIVER, then SWEEP. First the request-access form's mail
 * to the maintainer (#866); then the MCP pending-plan sweep (#806, shared by
 * every write tool since #812) and the access-request retention sweep. There is
 * no role-reminder pass any more (ADR-0028, #902): GavelUp never mails a member
 * on its own, so nothing here enqueues or sends to one.
 *
 * `DISABLE_REMINDER_POLLER=1` stops the delivery pass and NOT the sweeps —
 * see `startReminderPoller`. A pending plan holds a visitor's unmasked name,
 * email and phone, and the sweep is the only thing in the system that deletes
 * one, so letting the send flag disable it turned a 48-hour retention window
 * into an indefinite one.
 *
 * The delivery pass has its own try and `sweepTick` never throws, so a failing
 * delivery still lets the sweeps run. Exported for `reminder-poller.test.ts`,
 * which proves exactly that; nothing else calls it.
 *
 * Overlap guard: if the previous tick is still in flight when the interval fires
 * (a slow send batch), skip this one so ticks never stack up in the single
 * process. A thrown error is logged and swallowed — the poller must survive a
 * bad tick and keep running.
 */
export async function runReminderTick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		// The request-access form's emails (#866): request notifications and the
		// per-reason cap alerts. Its own try, so a throw cannot stop the sweep.
		try {
			const mail = await deliverAccessRequestMail();
			if (mail.sent + mail.failed + mail.alertsSent + mail.alertsFailed > 0) {
				console.log(
					`[access-requests] tick: sent=${mail.sent} failed=${mail.failed} alertsSent=${mail.alertsSent} alertsFailed=${mail.alertsFailed}`,
				);
			}
		} catch (err) {
			console.error("[access-requests] delivery pass failed:", err);
		}

		await sweepTick();
	} catch (err) {
		console.error("[reminders] poll tick failed:", err);
	} finally {
		ticking = false;
	}
}

/**
 * Delete MCP pending plans past their grace window (#806, #812).
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
 * `PENDING_PLAN_GRACE_MS` in `src/lib/pending-plan.ts`. A deployment that
 * wants confirm links to live longer lengthens those; nothing wants them to
 * live forever.
 *
 * Never throws: a failure here must not look like a delivery failure or stop
 * the next tick.
 */
async function sweepTick(): Promise<void> {
	try {
		// PER TOOL, since #812. One sweep now serves every MCP write tool's
		// retention, so a bare total stops saying which one actually ran — and
		// this is the only thing in the system that deletes these rows. The line
		// is built by a pure function in `src/lib/pending-plan.ts` because
		// `sweepTick` is private to a module that starts timers on import, so a
		// template written here is a template no test can read.
		const line = describePendingSweep(await sweepExpiredPendingPlans());
		if (line) console.log(line);
	} catch (err) {
		console.error("[mcp-pending] pending-plan sweep failed:", err);
	}
	// Access requests past their retention window (#866). Same reasoning as the
	// pending-plan sweep: these rows hold a prospect's name and email, so the
	// flag that stops SENDING must not stop this, and there is no flag for it.
	try {
		const swept = await sweepExpiredAccessRequests();
		if (swept.requests + swept.alerts > 0) {
			console.log(
				`[access-requests] retention sweep: requests=${swept.requests} alerts=${swept.alerts}`,
			);
		}
	} catch (err) {
		console.error("[access-requests] retention sweep failed:", err);
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
		`[mcp-pending] retention sweep started (interval=${intervalMs}ms)`,
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
		// pending-plan sweep sends nothing — it is the only thing in the system
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
		void runReminderTick();
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
