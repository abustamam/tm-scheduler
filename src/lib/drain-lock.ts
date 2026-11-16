// A cross-tab lock around one meeting's drain (#1638). CLIENT-ONLY.
//
// `drainingRef` in the hook is per tab, and the queue's read-then-write on
// IndexedDB is not atomic, so two tabs of the same browser can both drain one
// queue. Minutes ops were idempotent upserts and did not mind. A role op is not:
// with "assign X (expected open)" then "release (expected X)" queued, tab A
// applies both, and tab B, one op behind, replays the first against the now-open
// slot, finds it matches what it expected, and claims it for X again.
//
// `navigator.locks` is held for the whole drain, and the caller re-reads the
// queue INSIDE it, so a tab that waited sees only what is still queued. Where
// the API does not exist (an old browser, a test) the drain runs unlocked, as it
// did before.

export type DrainLockMode = "locked" | "unlocked";

/** Run `fn` holding this meeting's drain lock, telling it whether a lock is
 *  actually held (so it knows a re-read of the queue is meaningful). */
export async function withDrainLock<T>(
	meetingId: string,
	fn: (mode: DrainLockMode) => Promise<T>,
): Promise<T> {
	const locks =
		typeof navigator !== "undefined"
			? (navigator as Navigator & { locks?: LockManager }).locks
			: undefined;
	if (!locks || typeof locks.request !== "function") return fn("unlocked");
	return locks.request(`gavelup-drain:${meetingId}`, () => fn("locked"));
}
