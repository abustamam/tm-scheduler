/**
 * A small in-memory, process-local limiter for anonymous role feedback (#984).
 *
 * Keyed on the client address, but what it holds is a SALTED HASH of it, with
 * the salt drawn fresh per process: nothing here can be read back as an IP,
 * nothing is persisted, and nothing is logged. A restart forgets everything,
 * which is fine — this is a speed bump in front of the club write lock, not the
 * cap. The caps (20 per recipient, 300 per meeting) are enforced under the lock
 * in `role-feedback-logic.ts` and do not depend on this.
 *
 * Fixed window per key. The map is swept of expired entries as it is used and
 * hard-bounded at `maxKeys`, so a flood of distinct addresses cannot grow it
 * without limit (past the bound the oldest entries are dropped, which errs on
 * the side of admitting).
 */
import { createHash, randomBytes } from "node:crypto";

export interface IpLimiter {
	/** True if this address may proceed now; counts the attempt when it may. */
	take(ip: string, now?: number): boolean;
	/** Test hook: how many addresses are tracked. */
	size(): number;
}

export function createIpLimiter(opts: {
	limit: number;
	windowMs: number;
	maxKeys?: number;
}): IpLimiter {
	const salt = randomBytes(16);
	const maxKeys = opts.maxKeys ?? 10_000;
	const buckets = new Map<string, { count: number; resetAt: number }>();
	const keyOf = (ip: string) =>
		createHash("sha256").update(salt).update(ip).digest("base64url");

	function sweep(now: number) {
		for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
		// Map iteration is insertion order, so the first keys are the oldest.
		while (buckets.size >= maxKeys) {
			const first = buckets.keys().next().value;
			if (first === undefined) break;
			buckets.delete(first);
		}
	}

	return {
		take(ip, now = Date.now()) {
			const key = keyOf(ip);
			const b = buckets.get(key);
			if (!b || b.resetAt <= now) {
				if (!b) sweep(now);
				buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
				return true;
			}
			if (b.count >= opts.limit) return false;
			b.count++;
			return true;
		},
		size: () => buckets.size,
	};
}

/** Notes one address may send per minute. A room of phones each sends a
 *  handful; a script sending hundreds is what this stops. */
export const FEEDBACK_IP_LIMIT = 5;
export const FEEDBACK_IP_WINDOW_MS = 60_000;

/** The process's one limiter for `leaveFeedback`. */
export const feedbackIpLimiter = createIpLimiter({
	limit: FEEDBACK_IP_LIMIT,
	windowMs: FEEDBACK_IP_WINDOW_MS,
});
