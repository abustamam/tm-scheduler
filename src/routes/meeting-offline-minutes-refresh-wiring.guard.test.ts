/**
 * The meeting route's `useOfflineMinutes` `onMutated` wiring (#1600).
 *
 * The Ballot Counter console's winner box reads the vote tally from the query
 * cache, which `router.invalidate()` never touches. The fix is an expression on
 * the route: `onMutated` must hand the callback's OWN meeting-id parameter (the
 * meeting the drain wrote to, which can differ from the one on screen after a
 * hop) to `refreshAfterMeetingWrite`. Rendering the route to observe that is a
 * large fixture, so this is a comment-blind source guard ("must BE present"
 * form, hence `readSource`).
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

describe("meeting route → offline minutes refresh wiring (#1600)", () => {
	const src = readSource(ROUTE);

	it("onMutated calls refreshAfterMeetingWrite with its own meeting-id parameter", () => {
		// protects=the winner box refetching after a queued award change syncs, for
		//   the DRAINED meeting
		// fails_when=the parameter is replaced by meeting.id, the helper call is
		//   dropped, or router.invalidate() alone is used
		const m = src.match(
			/onMutated:\s*\(\s*(\w+)\s*\)\s*=>\s*refreshAfterMeetingWrite\(\s*\{[^}]*\},\s*(\w+)\s*,?\s*\)/,
		);
		expect(m, "onMutated must call refreshAfterMeetingWrite").not.toBeNull();
		expect(m?.[2]).toBe(m?.[1]);
	});

	it("passes the router invalidation and the query client to the helper", () => {
		expect(src).toMatch(
			/invalidateRouter:\s*\(\)\s*=>\s*router\.invalidate\(\)/,
		);
		expect(src).toMatch(/\{\s*invalidateRouter:[^}]*queryClient\s*\}/);
	});
});
