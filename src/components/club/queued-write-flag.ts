// Whether the write that just returned was QUEUED rather than sent (#1648).
//
// A queued write changed nothing on the server, so the caller's route refresh
// (`router.invalidate()`) must be skipped: offline the loader re-run fails and
// the route's error screen replaces the page. The queue refreshes the route
// itself when it drains.
//
// `offlineMinutes.mutate` runs the direct call only when it does not queue (or
// after a deadline, when the direct call is abandoned but keeps running), so "did
// THIS call's direct promise resolve before the write returned" is the signal.
//
// Why it is built this way (review of #1649): the verdict is a per-call local
// closed over by that call's own wrapper, and the shared ref is written ONCE, at
// the end of a write that did not throw. So
//  - a direct call that resolves late, after its write timed out into the queue,
//    only touches its own finished local, never another write's flag;
//  - a write that throws (STILL_SYNCING, an unqueueable op, a refused direct
//    call) leaves the ref alone: no refresh follows a throw, and the ref may
//    belong to another action still waiting for its refresh.
import { useMemo, useRef } from "react";

export type TrackDirect = <T>(direct: () => Promise<T>) => () => Promise<T>;

export function useQueuedWriteFlag() {
	const queuedRef = useRef(false);
	// Stable identity: callers list it in a dependency array.
	return useMemo(
		() => ({
			/** Runs one queue-capable write. `write` must pass its direct call through
			 *  `track` and hand the result to the queue. Resolves with the write's own
			 *  result; rethrows what it throws, leaving the flag alone. */
			async run<T>(write: (track: TrackDirect) => Promise<T>): Promise<T> {
				let directResolved = false;
				const track: TrackDirect = (direct) => async () => {
					const result = await direct();
					directResolved = true;
					return result;
				};
				const result = await write(track);
				// Read here, once: a late resolve after this line only sets the local.
				queuedRef.current = !directResolved;
				return result;
			},
			/** True once if the last write was queued; the caller then skips its
			 *  refresh. Clears the flag. */
			consume(): boolean {
				const queued = queuedRef.current;
				queuedRef.current = false;
				return queued;
			},
		}),
		[],
	);
}
