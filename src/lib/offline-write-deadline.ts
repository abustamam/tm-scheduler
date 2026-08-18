// The deadline every ONLINE minutes/roll write races against (#176). PURE +
// dependency-free, and it lives in `src/lib/` rather than inside
// `use-offline-minutes.ts` for the reason CLAUDE.md's "a test stated RELATIVE to
// the constant it guards cannot fail" bullet gives: the hook is reachable from
// vitest only through a rendered component, and a number that no test can name
// directly can be raised to an absurd value with the whole suite green. Here it
// is imported and asserted against an ABSOLUTE ceiling
// (`offline-write-deadline.test.ts`).
//
// WHY a deadline exists at all. The online/offline decision is `navigator.onLine`
// (`use-online-status.ts`), which is TRUE whenever the phone is associated to an
// access point — including one that routes nowhere: a captive portal, or the dead
// venue wifi this whole feature was built for. So `mutate()` took the online
// branch, `await onlineFn()` never settled, its `finally` never ran, `busy` stayed
// true forever, and the offline queue #176 exists for never engaged. The panel
// reflected that faithfully and uselessly — every chip and the guest group
// disabled, no spinner, no toast, no recovery short of a reload.

/**
 * How long an online write may hang before it is treated as "online but
 * unreachable" and handled as OFFLINE (the tap is queued instead of lost).
 *
 * 8 seconds. The bounds either side are real, which is why this is not a round
 * "1s to be safe":
 *
 *  • FLOOR — a write that is merely SLOW must not be timed out. One
 *    `setAttendance` round trip on congested club wifi is comfortably a
 *    multi-second affair, and a premature deadline queues a write that in fact
 *    landed. That is not corrupting (every op the drain replays is idempotent by
 *    construction — client-supplied ids and `onConflictDoNothing`; see
 *    `drain-minutes.ts`), but the chip does not move until the drain lands, so
 *    the officer taps again.
 *  • CEILING — past roughly ten seconds of a dead control with no spinner, an
 *    officer mid-roll-call concludes the app is broken and reloads, which is the
 *    outcome the deadline exists to prevent. A deadline longer than a human's
 *    patience is the hang wearing a number.
 */
export const ONLINE_WRITE_TIMEOUT_MS = 8_000;

/** What `raceWithDeadline` observed: the work finished, or the clock beat it. */
export type DeadlineOutcome = "settled" | "timeout";

/**
 * Resolve as soon as EITHER `work` settles or `ms` elapses.
 *
 * `work` is taken as an already-started promise rather than a thunk, so the
 * caller decides when the request leaves. A rejection is re-thrown (the caller's
 * existing error handling keeps working) — but only if it arrives before the
 * deadline; a LATE rejection is consumed by `Promise.race`'s own handler, so an
 * abandoned request cannot surface as an unhandled rejection.
 *
 * There is no cancellation: nothing here aborts the request, so a write that
 * times out may still land server-side. That is safe on this queue precisely
 * because every op it replays is idempotent (see the constant above), and it is
 * why the timeout path QUEUES the tap rather than reporting failure.
 */
export function raceWithDeadline(
	work: Promise<unknown>,
	ms: number,
): Promise<DeadlineOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<DeadlineOutcome>((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	return Promise.race([
		work.then((): DeadlineOutcome => "settled"),
		deadline,
	]).finally(() => {
		// Always cleared, on both arms and on a rejection: a live timer keeps a
		// vitest worker (and a real page) awake for the full deadline afterwards.
		if (timer !== undefined) clearTimeout(timer);
	});
}
