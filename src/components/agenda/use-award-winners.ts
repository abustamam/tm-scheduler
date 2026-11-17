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

type OverlayEntry = { op: AwardOp; stamp: number };
type Fetched = {
	/** The mount that fetched it; data from another mount is the last session's. */
	token: number;
	/** Where this fetch started in the shared ordering with overlay stamps. */
	startSeq: number;
	res: AwardReveal;
};
type AwardReveal = { winners: AwardWinner[] } | null;
/** An overlay entry a settled non-null answer, from a fetch that started after
 *  the entry's stamp, has confirmed. */
const isConfirmed = (e: OverlayEntry, settled: Fetched | null): boolean =>
	settled !== null && settled.res !== null && settled.startSeq > e.stamp;
/** Module-wide, so no two mounts of the hook ever share a token. */
let nextMountToken = 0;
const EMPTY_QUEUE: QueuedOp[] = [];
const EMPTY_OVERLAY: OverlayEntry[] = [];

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
 *   read stays projected in an in-memory overlay, stamped AFTER that read
 *   resolved. It drops out once a fetch that STARTED after the stamp returns
 *   non-null data; the drop is derived from the settled query result at render,
 *   so no render pairs a cleared overlay with the previous fetch's data. A
 *   `null` answer (signed out) keeps it until `onSlide` goes false, and leaving
 *   the slide clears only entries a `null` answer was holding.
 * - The cache outlives a sign-out (the QueryClient does), so `gcTime` is 0 and
 *   the hook consumes only data fetched since THIS mount (each fetch is tagged
 *   with the mount's token). A reopened deck shows the static slide until its
 *   own fetch answers, and offline never shows the last session's winners.
 * - Everything resets when `meetingId` changes.
 *
 * `onSlide` is whether the awards slide is on screen; `enabled` is whether the
 * deck has one at all.
 */
export function useAwardWinners(
	meetingId: string,
	{ enabled, onSlide }: { enabled: boolean; onSlide: boolean },
): AwardWinner[] {
	// One counter orders fetch starts against overlay stamps without a clock.
	const counter = useRef(0);
	const [mount, setMount] = useState<{ id: string; token: number } | null>(
		null,
	);
	useEffect(() => {
		setMount({ id: meetingId, token: ++nextMountToken });
	}, [meetingId]);
	const ready = mount !== null && mount.id === meetingId;
	const tokenRef = useRef(0);
	tokenRef.current = ready ? mount.token : 0;

	const [state, setState] = useState<{
		id: string;
		queue: QueuedOp[];
		overlay: OverlayEntry[];
	}>({ id: meetingId, queue: [], overlay: [] });
	const fresh = state.id === meetingId;
	const queue = fresh ? state.queue : EMPTY_QUEUE;
	const overlay = fresh ? state.overlay : EMPTY_OVERLAY;
	const prevQueue = useRef<QueuedOp[]>([]);
	const meetingRef = useRef(meetingId);
	if (meetingRef.current !== meetingId) {
		meetingRef.current = meetingId;
		prevQueue.current = [];
	}
	const readSeq = useRef(0);

	const readQueueNow = useCallback(async () => {
		const id = meetingId;
		const mine = ++readSeq.current;
		let next: QueuedOp[];
		let failed = false;
		try {
			next = await readQueue(id);
		} catch {
			// No IndexedDB (private window): there is no queue to show. Nothing
			// is treated as drained because of the throw.
			next = [];
			failed = true;
		}
		// A newer read, or another meeting, owns the state now.
		if (mine !== readSeq.current || id !== meetingRef.current) return;
		const stamp = ++counter.current;
		const still = new Set(next.map((o) => o.opId));
		const gone = failed
			? []
			: prevQueue.current.filter(
					(o): o is AwardOp => isAwardOp(o) && !still.has(o.opId),
				);
		prevQueue.current = next;
		setState((s) => {
			const base =
				s.id === id ? s : { id, queue: EMPTY_QUEUE, overlay: EMPTY_OVERLAY };
			return {
				id,
				queue: next,
				overlay:
					gone.length > 0
						? [...base.overlay, ...gone.map((op) => ({ op, stamp }))]
						: base.overlay,
			};
		});
	}, [meetingId]);
	const readQueueRef = useRef(readQueueNow);
	readQueueRef.current = readQueueNow;

	useEffect(() => {
		void readQueueNow();
		return subscribeAgendaChanged(() => {
			void readQueueNow();
		});
	}, [readQueueNow]);

	const query = useQuery({
		queryKey: ["award-reveal", meetingId],
		queryFn: async (): Promise<Fetched> => {
			const startSeq = ++counter.current;
			const token = tokenRef.current;
			try {
				// Imported on first use, not at module scope: the server-fn module
				// reaches the db, and a deck with no awards slide never needs it.
				const { getAwardReveal } = await import("#/server/award-reveal");
				const res = await getAwardReveal({ data: { meetingId } });
				return { token, startSeq, res };
			} finally {
				void readQueueRef.current();
			}
		},
		refetchInterval: AWARD_REVEAL_REFRESH_MS,
		retry: false,
		// The cache outlives an in-app sign-out; nothing may be kept for the next
		// deck to find.
		gcTime: 0,
		enabled: ready && enabled,
	});

	// Only data this mount fetched counts.
	const settled =
		ready && query.data && query.data.token === mount.token ? query.data : null;
	const settledRef = useRef<Fetched | null>(null);
	settledRef.current = settled;

	// Make the derived drop permanent.
	useEffect(() => {
		if (!settled) return;
		setState((s) =>
			s.overlay.some((e) => isConfirmed(e, settled))
				? { ...s, overlay: s.overlay.filter((e) => !isConfirmed(e, settled)) }
				: s,
		);
	}, [settled]);

	// Leaving the slide ends the overlay entries a `null` answer was holding;
	// entries nothing has confirmed or refused survive a re-entry.
	useEffect(() => {
		if (onSlide) return;
		const latest = settledRef.current;
		if (!latest || latest.res !== null) return;
		setState((s) => ({
			...s,
			overlay: s.overlay.filter((e) => !(latest.startSeq > e.stamp)),
		}));
	}, [onSlide]);

	const fetched = settled?.res?.winners ?? null;
	return useMemo(
		() =>
			projectAwards(
				fetched,
				queue,
				overlay.filter((e) => !isConfirmed(e, settled)).map((e) => e.op),
			),
		[fetched, queue, overlay, settled],
	);
}
