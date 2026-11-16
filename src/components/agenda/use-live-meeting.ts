import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { subscribeAgendaChanged } from "#/lib/agenda-live";

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
 * `fetcher` is injected: the route passes the server fn plus its public
 * projection, a test passes a stub.
 */
export function useLiveMeeting<T>(
	snapshot: T,
	queryKey: readonly unknown[],
	fetcher: () => Promise<T>,
): T {
	const query = useQuery({
		queryKey: ["live-meeting", ...queryKey],
		queryFn: fetcher,
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

	// `initialData` means `data` is never undefined here.
	return query.data as T;
}
