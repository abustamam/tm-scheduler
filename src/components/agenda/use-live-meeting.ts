import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeAgendaChanged } from "#/lib/agenda-live";
import { subscribeRoleOpsDrained } from "#/lib/drained-roles";
import { type QueuedOp, readQueue } from "#/lib/offline-minutes-queue";
import {
	type DrainedRoleOp,
	type ProjectableSlot,
	projectDrained,
	projectSlots,
} from "#/lib/project-slots";

/** The poll for edits from another device. */
export const LIVE_MEETING_REFRESH_MS = 30_000;
/** Broadcast refetches collapse to one per second (leading and trailing). */
export const LIVE_MEETING_THROTTLE_MS = 1_000;

/**
 * The meeting as the projected deck should show it (#1637): the SNAPSHOT the
 * loader read, replaced by a fresher copy whenever a best-effort re-read
 * succeeds. Modeled on `useNextMeetingRefresh` (#932) and with the same
 * contract: a refresh that throws (network off, meeting deleted, club archived
 * mid-meeting, which `getPublicMeetingByKey` signals by throwing) is silent and
 * the last good copy stays; nothing here reads `error` or `isFetching`, so a
 * failure cannot reach the screen and the deck never blanks mid-meeting.
 *
 * Two signals trigger one re-read: a 30s poll that also runs in a hidden tab
 * (the deck is often a background window while the driver edits elsewhere), and
 * a same-browser broadcast, throttled leading and trailing at 1s so a stream of
 * saves cannot postpone the refetch.
 *
 * Queued role edits show at once (#1638). A payload that carries `slots` and a
 * `meeting.id` is returned with `projectSlots(payload.slots, queue)`, where the
 * queue is this meeting's offline queue read straight from IndexedDB: on mount,
 * on every broadcast and after every refetch settles. That read is its own
 * state, NOT chained behind the throttled network refetch, so offline the deck
 * follows the queue however long a refetch hangs. A drained op (the drain says
 * so on the same channel) keeps projecting in an in-memory overlay until a
 * server read that STARTED after the drain's removal succeeds, so the deck
 * never flashes back to a stale name between the dequeue and the refetch.
 *
 * `fetcher` is injected: the route passes the server fn plus its public
 * projection, a test passes a stub.
 */
export function useLiveMeeting<T>(
	snapshot: T,
	queryKey: readonly unknown[],
	fetcher: () => Promise<T>,
): T {
	const meetingId = (snapshot as { meeting?: { id?: unknown } } | null)?.meeting
		?.id;
	const queueMeetingId = typeof meetingId === "string" ? meetingId : null;
	const [queue, setQueue] = useState<QueuedOp[]>([]);
	// Drained ops still projected, each with the time its drain announced it.
	const [overlay, setOverlay] = useState<
		{ entry: DrainedRoleOp; at: number }[]
	>([]);

	const readQueueNow = useCallback(async () => {
		if (!queueMeetingId) return;
		try {
			setQueue(await readQueue(queueMeetingId));
		} catch {
			// No IndexedDB (private window): there is no queue to show.
		}
	}, [queueMeetingId]);
	const readQueueRef = useRef(readQueueNow);
	readQueueRef.current = readQueueNow;

	const query = useQuery({
		queryKey: ["live-meeting", ...queryKey],
		queryFn: async () => {
			const startedAt = Date.now();
			try {
				const fresh = await fetcher();
				// A read that started after an op's removal has the op's effect:
				// the overlay for it can go.
				setOverlay((o) => o.filter((e) => e.at >= startedAt));
				return fresh;
			} finally {
				// After every poll, success or not.
				void readQueueRef.current();
			}
		},
		initialData: snapshot,
		staleTime: LIVE_MEETING_REFRESH_MS,
		refetchInterval: LIVE_MEETING_REFRESH_MS,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: false,
		retry: false,
		// Same reason as the next-meeting refresh: a reopened deck must start from
		// its loader's snapshot, not the last session's cached copy.
		gcTime: 0,
	});
	const refetch = useRef(query.refetch);
	refetch.current = query.refetch;

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let pending = false;
		const fire = () => {
			void refetch.current();
			timer = setTimeout(() => {
				timer = null;
				if (pending) {
					pending = false;
					fire();
				}
			}, LIVE_MEETING_THROTTLE_MS);
		};
		const unsubscribe = subscribeAgendaChanged(() => {
			if (timer == null) fire();
			else pending = true;
		});
		return () => {
			unsubscribe();
			if (timer) clearTimeout(timer);
		};
	}, []);

	// The queue, on mount and on every broadcast. Not throttled and not behind
	// the refetch above.
	useEffect(() => {
		void readQueueRef.current();
		const unsubscribe = subscribeAgendaChanged(() => {
			void readQueueRef.current();
		});
		const unsubscribeDrained = subscribeRoleOpsDrained((drained, at) => {
			setOverlay((o) => [...o, ...drained.map((entry) => ({ entry, at }))]);
		});
		return () => {
			unsubscribe();
			unsubscribeDrained();
		};
	}, []);

	// `initialData` means `data` is never undefined here.
	const data = query.data as T;
	return useMemo(() => {
		const slots = (data as { slots?: unknown } | null)?.slots;
		if (!Array.isArray(slots)) return data;
		const projected = projectSlots(
			projectDrained(
				slots as ProjectableSlot[],
				overlay.map((o) => o.entry),
			),
			queue,
		);
		return projected === slots ? data : { ...data, slots: projected };
	}, [data, queue, overlay]);
}
