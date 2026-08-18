// WHICH minutes a surface should be reading right now, given the offline write
// queue (#176). PURE + CLIENT-ONLY.
//
// ONE copy, shared by the two surfaces that read through the queue: the
// attendance panel's roll rows (`roll-attendance.ts`, three derivations) and the
// Minutes card's `displayMinutes`. It was the same three lines written twice,
// under a comment in `roll-attendance.ts` saying they were "deliberately copied
// rather than improved on, so the panel and the Minutes card cannot disagree
// about what is recorded while the queue is draining" — a promise a copy cannot
// keep. They then had the SAME BUG twice, and fixing it meant finding both.
//
// TYPE-ONLY imports of `#/server/minutes-logic` keep `#/db` (and so `pg`) out of
// the client bundle and out of this module's unit test.
import type { MinutesData } from "#/server/minutes-logic";
import { deriveMinutes } from "./derive-minutes";
import type { MinutesOp } from "./offline-minutes-queue";

/** What every projection reads. One shape so the callers cannot be written
 *  differently from each other. */
export type ProjectionInput = {
	online: boolean;
	minutes: MinutesData | null;
	snapshot: MinutesData | null;
	queue: MinutesOp[];
};

/**
 * The minutes to render, or `null` if there is nothing to read (`minutes` is
 * `null` for a viewer who may not read the minutes at all).
 *
 * WHICH BASE depends on connectivity: online the loader payload is the freshest
 * thing there is; offline it can be older than the last state the server
 * confirmed (a cached document, a reload with no network), so the snapshot wins.
 *
 * WHETHER TO REPLAY depends on the QUEUE, and only on the queue. This used to be
 * `online ? base : deriveMinutes(base, queue)`, whose comment said "online, the
 * server is the source of truth and the UI moves via the loader refetch
 * `offlineMinutes.mutate` triggers". That is false for the state the write
 * deadline introduced: `writeOnline` returns `"queue"` on a timeout WITHOUT
 * calling `onMutated`, so no refetch ever lands — and `online` is still `true`,
 * because `navigator.onLine` is true on dead venue wifi. The officer taps
 * Present, waits 8s with every chip disabled, gets "saved on this device and
 * will sync later", and THE CHIP DOES NOT MOVE. So they tap again, which is the
 * exact behaviour the projection exists to prevent. `sync-status.tsx` was fixed
 * for this same state ("a write abandoned at its deadline queues with
 * `navigator.onLine` still true") and the projection was not, leaving the
 * indicator saying "1 change not yet synced" beside a chip reading unmarked.
 *
 * Replaying an op the server has ALREADY applied is safe here, and it is safe for
 * a stronger reason than idempotence: the drain re-dispatches every op still in
 * the queue (`runDrain`), so the projection is showing what the server is going
 * to be told, not a guess. Most op types are idempotent on top of that
 * (`setAttendance` is last-write-wins, `addGuest` de-dups by `guestId`,
 * `addTableTopics` is keyed by client id, the removes are filters);
 * `moveTableTopics` is the exception, and it double-applies on the drain too,
 * which is a queue-semantics question and not a display one.
 */
export function projectMinutes({
	online,
	minutes,
	snapshot,
	queue,
}: ProjectionInput): MinutesData | null {
	const base = online ? minutes : (snapshot ?? minutes);
	if (!base) return null;
	// `deriveMinutes` structuredClones, so the empty-queue case — every render in
	// the steady state — must not pay for it. That is also what keeps the returned
	// identity stable for a `useMemo` consumer when there is nothing to replay.
	return queue.length > 0 ? deriveMinutes(base, queue) : base;
}
