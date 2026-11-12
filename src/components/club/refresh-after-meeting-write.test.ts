// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/server/voting", () => ({}));
vi.mock("#/server/minutes-logic", () => ({}));

const { refreshAfterMeetingWrite } = await import(
	"./refresh-after-meeting-write"
);
const { voteTallyKey } = await import("./vote-counter-panel");

describe("refreshAfterMeetingWrite", () => {
	it("invalidates the written meeting's vote tally and the router, not another meeting's (#1600)", async () => {
		// protects=the console's winner box refetching after an offline award syncs
		// fails_when=the tally key is not invalidated, or the wrong meeting's is
		const queryClient = new QueryClient();
		queryClient.setQueryData(voteTallyKey("meet-1"), { winner: "old" });
		queryClient.setQueryData(voteTallyKey("meet-2"), { winner: "other" });
		const invalidateRouter = vi.fn(async () => {});
		await refreshAfterMeetingWrite({ invalidateRouter, queryClient }, "meet-1");
		expect(invalidateRouter).toHaveBeenCalledTimes(1);
		expect(
			queryClient.getQueryState(voteTallyKey("meet-1"))?.isInvalidated,
		).toBe(true);
		expect(
			queryClient.getQueryState(voteTallyKey("meet-2"))?.isInvalidated,
		).toBe(false);
	});
});
