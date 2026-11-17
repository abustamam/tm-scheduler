import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeAgendaChanged } from "#/lib/agenda-live";
import { type QueuedOp, readQueue } from "#/lib/offline-minutes-queue";
import {
	type AwardOp,
	type AwardWinner,
	isAwardOp,
	projectAwards,
} from "#/lib/project-awards";

/** The poll, matching the vote-participation badge's cadence. */
export const AWARD_REVEAL_REFRESH_MS = 5000;

/**
 * The winners the Present deck reveals (#1654): the session-gated
 * `getAwardReveal` read with this browser's queued `setAward` / `clearAward`
 * ops projected over it (D7). Structured like `useLiveMeeting`, which it does
 * not touch.
 *
 * - The query is `enabled` only after a mount effect sets a flag, so the server
 *   render and the first client render both show the static slide.
 * - The queue is its own state: read on mount, on every `agenda-changed`
 *   broadcast and after every fetch settles, never chained behind the fetch, so
 *   offline the deck follows the queue however long a fetch hangs. A read that
 *   throws (no IndexedDB) counts as an empty queue.
 * - The award drain announces nothing, so an award op that VANISHES from a queue
 *   read stays projected in an in-memory overlay, stamped with that read's time.
 *   It drops out once a fetch that STARTED after the stamp returns non-null
 *   data. A `null` answer (signed out) keeps it until `onSlide` goes false.
 *
 * `onSlide` is whether the awards slide is on screen; `enabled` is whether the
 * deck has one at all.
 */
export function useAwardWinners(
	meetingId: string,
	{ enabled, onSlide }: { enabled: boolean; onSlide: boolean },
): AwardWinner[] {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const [queue, setQueue] = useState<QueuedOp[]>([]);
	const [overlay, setOverlay] = useState<{ op: AwardOp; at: number }[]>([]);
	const prevQueue = useRef<QueuedOp[]>([]);

	const readQueueNow = useCallback(async () => {
		const at = Date.now();
		let next: QueuedOp[];
		try {
			next = await readQueue(meetingId);
		} catch {
			// No IndexedDB (private window): there is no queue to show.
			return;
		}
		const still = new Set(next.map((o) => o.opId));
		const gone = prevQueue.current.filter(
			(o): o is AwardOp => isAwardOp(o) && !still.has(o.opId),
		);
		prevQueue.current = next;
		setQueue(next);
		if (gone.length > 0) {
			setOverlay((o) => [...o, ...gone.map((op) => ({ op, at }))]);
		}
	}, [meetingId]);
	const readQueueRef = useRef(readQueueNow);
	readQueueRef.current = readQueueNow;

	useEffect(() => {
		void readQueueRef.current();
		return subscribeAgendaChanged(() => {
			void readQueueRef.current();
		});
	}, []);

	// Leaving the slide ends an overlay a `null` answer was holding.
	useEffect(() => {
		if (!onSlide) setOverlay([]);
	}, [onSlide]);

	const query = useQuery({
		queryKey: ["award-reveal", meetingId],
		queryFn: async () => {
			const startedAt = Date.now();
			try {
				// Imported on first use, not at module scope: the server-fn module
				// reaches the db, and a deck with no awards slide never needs it.
				const { getAwardReveal } = await import("#/server/award-reveal");
				const res = await getAwardReveal({ data: { meetingId } });
				if (res !== null) {
					setOverlay((o) => o.filter((e) => e.at >= startedAt));
				}
				return res;
			} finally {
				void readQueueRef.current();
			}
		},
		refetchInterval: AWARD_REVEAL_REFRESH_MS,
		retry: false,
		enabled: mounted && enabled,
	});

	const fetched = query.data?.winners ?? null;
	return useMemo(
		() =>
			projectAwards(
				fetched,
				queue,
				overlay.map((e) => e.op),
			),
		[fetched, queue, overlay],
	);
}
