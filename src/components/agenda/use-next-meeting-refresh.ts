import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { NextMeetingSummary } from "#/lib/next-meeting-summary";

/** How often the deck re-reads the next meeting's line-up while it is up. A
 *  minute, not the vote badge's five seconds: a role claimed from a phone in
 *  the room shows up before the presenter has left the slide, and a deck left
 *  open for two hours costs 120 small reads rather than 1,440. */
export const NEXT_MEETING_REFRESH_MS = 60_000;

/**
 * The next meeting as the deck should show it (#932): the SNAPSHOT loaded with
 * the deck, replaced by a fresher copy whenever a best-effort refresh succeeds.
 *
 * The snapshot is the contract. The presenting laptop may have no wifi, so the
 * slide must render complete from what was loaded — a refresh that fails is
 * SILENT: no spinner, no error, no blank roles, and the last good copy stays.
 * TanStack Query keeps `data` across a failed refetch, `retry: false` stops it
 * hammering a dead network, and nothing here reads `error` or `isFetching`, so
 * there is no way for a failure to reach the screen.
 *
 * Two further rules, both about keeping the deck's shape steady mid-meeting:
 *
 *   - No snapshot, no polling. A deck loaded with no next meeting has no slide
 *     for a refresh to fill, and adding one mid-presentation would shift every
 *     slide number after it under the presenter's feet.
 *   - A refresh that answers "no next meeting" keeps the LAST GOOD copy — the
 *     newest non-null answer, else the snapshot — for the same reason in
 *     reverse: the slide does not vanish from under the presenter, and it does
 *     not step back to a line-up older than one it has already shown.
 *
 * `fetcher` is injected so the route passes the server fn and a test passes a
 * function that rejects.
 */
export function useNextMeetingRefresh(
	snapshot: NextMeetingSummary | null,
	queryKey: readonly unknown[],
	fetcher: () => Promise<NextMeetingSummary | null>,
): NextMeetingSummary | null {
	const query = useQuery({
		queryKey: ["next-meeting-summary", ...queryKey],
		queryFn: fetcher,
		initialData: snapshot,
		// The snapshot is fresh for a full interval, so mounting does not
		// immediately re-read what the loader just read.
		staleTime: NEXT_MEETING_REFRESH_MS,
		refetchInterval: NEXT_MEETING_REFRESH_MS,
		refetchOnWindowFocus: false,
		retry: false,
		// Drop the cache the moment the deck closes. React Query ignores
		// `initialData` for a key it still holds, so a deck reopened within the
		// default five minutes started from the LAST session's copy — and, with
		// no snapshot, never polled to correct it: a meeting cancelled in between
		// stayed on the slide and in the exported .pptx.
		gcTime: 0,
		enabled: snapshot != null,
	});
	// The newest non-null answer seen, refreshes included. A ref, not state:
	// it changes only alongside `query.data`, which already re-renders.
	const lastGood = useRef(snapshot);
	if (query.data) lastGood.current = query.data;
	return query.data ?? lastGood.current;
}
