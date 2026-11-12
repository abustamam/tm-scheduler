import type { QueryClient } from "@tanstack/react-query";
import { voteTallyKey } from "./vote-counter-panel";

/**
 * What the meeting route refreshes after the offline-minutes hook reports that
 * server state changed (#1600). The router's loader data covers the Awards
 * list; the Ballot Counter console's winner lives in the query cache under
 * `voteTallyKey`, which `router.invalidate()` never touches. `meetingId` is the
 * meeting the write belongs to, not the one on screen.
 */
export async function refreshAfterMeetingWrite(
	deps: { invalidateRouter: () => Promise<unknown>; queryClient: QueryClient },
	meetingId: string,
): Promise<void> {
	await Promise.all([
		deps.invalidateRouter(),
		deps.queryClient.invalidateQueries({ queryKey: voteTallyKey(meetingId) }),
	]);
}
